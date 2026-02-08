const cron = require('node-cron');
const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const https = require('https');

const app = express();
const port = process.env.PORT || 3000;

// ==================================================================
// 🔍 1. 启动检查与数据库连接
// ==================================================================
let supabase = null;
const requiredEnv = ['API_KEY', 'SUPABASE_URL', 'SUPABASE_SERVICE_KEY'];
const missingEnv = requiredEnv.filter(key => !process.env[key]);

if (missingEnv.length > 0) {
    console.error(`\n❌❌❌ [启动警告] 缺少环境变量: ${missingEnv.join(', ')}`);
} else {
    try {
        supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
        console.log('✅ Supabase 数据库连接成功');
    } catch (err) {
        console.error('❌ Supabase 初始化失败:', err.message);
    }
}

// [修改] 开启 keepAlive，防止大文件上传时连接中断
const ignoreSSL = new https.Agent({ 
    rejectUnauthorized: false,
    keepAlive: true 
});
const corsOptions = { origin: (o, c) => c(null, true) };

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json({ limit: '50mb' }));
app.use(cors(corsOptions));

app.get('/', (req, res) => res.send('Z-AI Proxy Server Running (Multipart Fix)...'));

// ==================================================================
// 🟢 2. 模型配置
// ==================================================================
const MODEL_REGISTRY = {
    'gemini-3-pro-image-preview-async':    { type: 'async', path: '/v1/videos', cost: 5 },
    'gemini-3-pro-image-preview-2k-async': { type: 'async', path: '/v1/videos', cost: 10 },
    'gemini-3-pro-image-preview-4k-async': { type: 'async', path: '/v1/videos', cost: 15 },
    'gemini-3-pro-image-preview':          { type: 'sync',  path: '/v1/images/generations', cost: 5 },
    'dall-e-3':                            { type: 'sync',  path: '/v1/images/generations', cost: 20 },
    'default':                             { type: 'async', path: '/v1/videos', cost: 5 }
};

// ==================================================================
// 🛠️ 3. 工具函数：原生构建 Multipart 表单 (最终兼容稳健版)
// ==================================================================
function generateMultipartBody(fields) {
    // 使用随机 Boundary
    const boundary = 'BananaBoundary-' + Date.now().toString(16);
    const crlf = '\r\n';
    const chunks = [];

    for (const [key, value] of Object.entries(fields)) {
        if (value === undefined || value === null) continue;

        const values = Array.isArray(value) ? value : [value];

        values.forEach((item, index) => {
            let partData = item;
            // 基础 Header
            let partHeaders = [`Content-Disposition: form-data; name="${key}"`];

            // 识别图片 DataURL
            if (key === 'image' && typeof item === 'string' && item.startsWith('data:')) {
                const commaIndex = item.indexOf(',');
                const semicolonIndex = item.indexOf(';');
                const colonIndex = item.indexOf(':');

                if (commaIndex > 0 && semicolonIndex > colonIndex) {
                    const mimeType = item.substring(colonIndex + 1, semicolonIndex);
                    const ext = mimeType.split('/')[1] || 'png';
                    
                    // [修改] 仅保留 filename 和 Content-Type，移除 Content-Transfer-Encoding 以提高兼容性
                    partHeaders[0] += `; filename="image_${index}.${ext}"`;
                    partHeaders.push(`Content-Type: ${mimeType}`);
                    
                    // 提取二进制数据
                    const base64Str = item.substring(commaIndex + 1);
                    partData = Buffer.from(base64Str, 'base64');
                }
            }

            chunks.push(Buffer.from(`--${boundary}${crlf}`));
            chunks.push(Buffer.from(partHeaders.join(crlf) + crlf + crlf));
            
            if (Buffer.isBuffer(partData)) {
                chunks.push(partData);
            } else {
                chunks.push(Buffer.from(String(partData)));
            }
            chunks.push(Buffer.from(crlf));
        });
    }
    // 结尾边界
    chunks.push(Buffer.from(`--${boundary}--${crlf}`));

    return {
        boundary,
        body: Buffer.concat(chunks)
    };
}

// ==================================================================
// 🟢 4. 统一调度接口
// ==================================================================
app.post('/api/proxy', async (req, res) => {
    if (!supabase) return res.status(500).json({ error: { message: "数据库未连接" } });

    let userForRefund = null;
    let costForRefund = 0;

    try {
        const authHeader = req.headers.authorization;
        if (!authHeader) return res.status(401).json({ error: { message: "No Token" } });
        
        const { data: { user }, error: authError } = await supabase.auth.getUser(authHeader.split(' ')[1]);
        if (authError || !user) return res.status(403).json({ error: { message: "Invalid Token" } });

        const modelName = req.body.model;
        const config = MODEL_REGISTRY[modelName] || MODEL_REGISTRY['default'];
        
        const cost = config.cost;
        costForRefund = cost;
        userForRefund = user;

        console.log(`🤖 Model: ${modelName} | Mode: ${config.type.toUpperCase()} | User: ${user.email}`);

        const { error: creditError } = await supabase.rpc('decrement_credits', { count: cost, x_user_id: user.id });
        if (creditError) return res.status(402).json({ error: { message: "积分不足" } });

        let resultUrl = "";
        if (config.type === 'async') {
            resultUrl = await handleAsyncGeneration(req.body, config.path);
        } else {
            resultUrl = await handleSyncGeneration(req.body, config.path, user.id);
        }

        res.status(200).json({ created: Date.now(), data: [{ url: resultUrl }] });

    } catch (error) {
        console.error("❌ 处理错误:", error.message);
        if (userForRefund) {
            await supabase.rpc('increment_credits', { count: costForRefund, x_user_id: userForRefund.id });
        }
        res.status(500).json({ error: { message: error.message || "Server Error" } });
    }
});

// ==================================================================
// 🔵 5. 异步引擎 (兼容性修复：Boundary 加引号 + KeepAlive)
// ==================================================================
async function handleAsyncGeneration(body, apiPath) {
    const baseUrl = "https://api.tu-zi.com";
    
    const fields = {
        model: body.model,
        prompt: body.prompt,
        size: body.size || "16:9"
    };

    if (body.images && body.images.length > 0) {
        fields.image = body.images; 
    }

    const { boundary, body: multipartData } = generateMultipartBody(fields);

    // 提交任务
    const submitRes = await fetch(`${baseUrl}${apiPath}`, {
        method: 'POST',
        headers: { 
            // [修改] 这里的 boundary 值加上双引号，这是某些严格服务器的要求
            'Content-Type': `multipart/form-data; boundary="${boundary}"`,
            'Content-Length': multipartData.length.toString(),
            'Authorization': `Bearer ${process.env.API_KEY}` 
        },
        body: multipartData,
        agent: ignoreSSL // 确保这里使用了开启 keepAlive 的 agent
    });

    if (!submitRes.ok) throw new Error(`提交失败: ${await submitRes.text()}`);
    
    // ... 后面的轮询逻辑保持不变 ...
    const taskData = await submitRes.json();
    const taskId = taskData.id;

    // 轮询等待
    let attempts = 0;
    while (attempts < 60) {
        await new Promise(r => setTimeout(r, 2000));
        attempts++;
        const checkRes = await fetch(`${baseUrl}${apiPath}/${taskId}`, {
            headers: { 'Authorization': `Bearer ${process.env.API_KEY}` },
            agent: ignoreSSL
        });
        
        if (!checkRes.ok) continue;
        const statusData = await checkRes.json();
        
        if (statusData.status === 'completed' || statusData.status === 'succeeded') {
            return statusData.video_url || statusData.url;
        } else if (statusData.status === 'failed') {
            throw new Error("生成失败 (API Status: failed)");
        }
    }
    throw new Error("生成超时");
}
// ==================================================================
// 🟠 6. 同步引擎 (保持 JSON 发送)
// ==================================================================
async function handleSyncGeneration(body, apiPath, userId) {
    const baseUrl = "https://api.tu-zi.com"; 
    let sizeParam = "1024x1024";
    if (body.size === "16:9") sizeParam = "1792x1024";
    else if (body.size === "3:4") sizeParam = "1024x1792";

    const payload = {
        model: body.model,
        prompt: body.prompt,
        size: sizeParam,
        n: 1,
        response_format: "url"
    };

    const res = await fetch(`${baseUrl}${apiPath}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.API_KEY}` },
        body: JSON.stringify(payload),
        agent: ignoreSSL
    });

    if (!res.ok) throw new Error(`生成失败: ${await res.text()}`);
    const data = await res.json();
    
    if (data.data && data.data.length > 0) {
        const item = data.data[0];
        if (item.url) return item.url;
        if (item.b64_json && supabase) {
            console.log("⚠️ 转存 Base64...");
            const buffer = Buffer.from(item.b64_json, 'base64');
            const fileName = `temp/${userId}/sync_${Date.now()}.png`;
            const { error } = await supabase.storage.from('ai-images').upload(fileName, buffer, { contentType: 'image/png' });
            if (error) throw new Error("转存失败");
            const { data: publicData } = supabase.storage.from('ai-images').getPublicUrl(fileName);
            return publicData.publicUrl;
        }
    }
    throw new Error("无法识别返回格式");
}

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(port, () => console.log(`✅ 服务器已启动 (Port ${port})`));

// 自动清理任务
cron.schedule('0 0 * * *', async () => {
    if (!supabase) return;
    const BUCKET_NAME = 'ai-images'; 
    const ROOT_FOLDER = 'temp';
    try {
        const { data: folders } = await supabase.storage.from(BUCKET_NAME).list(ROOT_FOLDER);
        if (!folders) return;
        for (const folder of folders) {
            if (folder.name === '.emptyFolderPlaceholder') continue;
            const path = `${ROOT_FOLDER}/${folder.name}`;
            const { data: files } = await supabase.storage.from(BUCKET_NAME).list(path);
            if (files?.length) {
                await supabase.storage.from(BUCKET_NAME).remove(files.map(f => `${path}/${f.name}`));
            }
        }
        console.log('✅ 每日清理完成');
    } catch (err) {
        console.error('清理错误:', err.message);
    }
});





