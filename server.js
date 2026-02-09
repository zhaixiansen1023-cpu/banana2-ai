// const FormData = require('form-data'); // ❌ 弃用第三方库，改用原生拼接
const cron = require('node-cron');
const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const https = require('https');

const app = express();
const port = process.env.PORT || 8080;

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

// [修改] 强制短连接，避免 502/EOF
const ignoreSSL = new https.Agent({ 
    rejectUnauthorized: false
});
const corsOptions = { origin: (o, c) => c(null, true) };

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json({ limit: '50mb' })); 
app.use(cors(corsOptions));

app.get('/', (req, res) => res.send('Z-AI Proxy Server Running (Native Multipart Mode)...'));

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
// 🛠️ 3. [新] 原生 Multipart 拼接函数 (绝对精确控制)
// ==================================================================
function buildMultipartPayload(fields, files, boundary) {
    const CRLF = '\r\n'; // 必须使用 \r\n 换行
    const chunks = [];

    // 1. 处理普通字段
    for (const [key, value] of Object.entries(fields)) {
        if (value === undefined || value === null) continue;
        chunks.push(Buffer.from(`--${boundary}${CRLF}`));
        chunks.push(Buffer.from(`Content-Disposition: form-data; name="${key}"${CRLF}${CRLF}`));
        chunks.push(Buffer.from(`${value}${CRLF}`));
    }

    // 2. 处理文件 (Buffer)
    if (files && files.length > 0) {
        files.forEach(file => {
            chunks.push(Buffer.from(`--${boundary}${CRLF}`));
            chunks.push(Buffer.from(`Content-Disposition: form-data; name="${file.fieldname}"; filename="${file.filename}"${CRLF}`));
            chunks.push(Buffer.from(`Content-Type: ${file.contentType}${CRLF}${CRLF}`));
            chunks.push(file.buffer); // 直接推入二进制 Buffer
            chunks.push(Buffer.from(CRLF)); // 文件末尾换行
        });
    }

    // 3. 结束边界 (注意后面的 --)
    chunks.push(Buffer.from(`--${boundary}--${CRLF}`));

    return Buffer.concat(chunks);
}

// ==================================================================
// 🔵 4. 异步引擎 (使用原生拼接，解决 EOF)
// ==================================================================
async function handleAsyncGeneration(body, apiPath) {
    const baseUrl = "https://api.tu-zi.com";
    
    // 生成一个简单的 Boundary，类似于浏览器
    const boundary = `----WebKitFormBoundary${Date.now().toString(16)}`;

    // 准备字段
    const fields = {
        model: body.model,
        prompt: body.prompt,
        size: body.size || "16:9"
    };

    // 准备文件列表
    const files = [];
    if (body.images && body.images.length > 0) {
        body.images.forEach((imgStr, index) => {
            if (typeof imgStr === 'string' && imgStr.startsWith('data:')) {
                const matches = imgStr.match(/^data:(.+);base64,(.+)$/);
                if (matches) {
                    const mimeType = matches[1];
                    const buffer = Buffer.from(matches[2], 'base64');
                    const ext = mimeType.split('/')[1] || 'png';
                    files.push({
                        fieldname: 'image', // 如果还报错，可以尝试改为 'file'
                        filename: `image_${index}.${ext}`,
                        contentType: mimeType,
                        buffer: buffer
                    });
                }
            }
        });
    }

    // [🔥核心] 手动构建 Payload，不依赖任何第三方库
    const payloadBuffer = buildMultipartPayload(fields, files, boundary);

    console.log(`[Proxy] 发送 Payload 大小: ${payloadBuffer.length} bytes`);

    // 提交任务
    const submitRes = await fetch(`${baseUrl}${apiPath}`, {
        method: 'POST',
        headers: { 
            'Authorization': `Bearer ${process.env.API_KEY}`,
            'Content-Type': `multipart/form-data; boundary=${boundary}`, // 显式指定 boundary
            'Content-Length': payloadBuffer.length, // 显式指定长度
            'Connection': 'close'
        },
        body: payloadBuffer,
        agent: ignoreSSL
    });

    // 安全解析
    const responseText = await submitRes.text();
    let taskData;
    try {
        taskData = JSON.parse(responseText);
    } catch (e) {
        throw new Error(`API 响应异常 (非JSON): ${responseText.substring(0, 200)}`);
    }

    if (!submitRes.ok) {
        throw new Error(`提交失败 [${submitRes.status}]: ${JSON.stringify(taskData)}`);
    }
    
    const taskId = taskData.id || taskData.data?.id;
    if (!taskId) throw new Error(`未获取到任务ID: ${responseText}`);

    // 轮询等待
    let attempts = 0;
    while (attempts < 60) {
        await new Promise(r => setTimeout(r, 2000));
        attempts++;
        const checkRes = await fetch(`${baseUrl}${apiPath}/${taskId}`, {
            headers: { 
                'Authorization': `Bearer ${process.env.API_KEY}`,
                'Connection': 'close'
            },
            agent: ignoreSSL
        });
        
        if (!checkRes.ok) continue;
        
        const checkText = await checkRes.text();
        let statusData;
        try {
            statusData = JSON.parse(checkText);
        } catch (e) { continue; }
        
        if (statusData.status === 'completed' || statusData.status === 'succeeded') {
            return statusData.video_url || statusData.url || (statusData.images && statusData.images[0]?.url);
        } else if (statusData.status === 'failed') {
            throw new Error(`生成失败: ${JSON.stringify(statusData)}`);
        }
    }
    throw new Error("生成超时");
}

// ==================================================================
// 🟢 5. 统一调度接口
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
// 🟠 6. 同步引擎
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

    const text = await res.text();
    let data;
    try {
        data = JSON.parse(text);
    } catch(e) {
        throw new Error(`同步接口错误 (非JSON): ${text.substring(0, 100)}`);
    }
    
    if (!res.ok) throw new Error(`生成失败: ${JSON.stringify(data)}`);

    if (data.data && data.data.length > 0) {
        const item = data.data[0];
        if (item.url) return item.url;
        if (item.b64_json && supabase) {
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
    try {
        const BUCKET_NAME = 'ai-images'; 
        const ROOT_FOLDER = 'temp';
        const { data: folders } = await supabase.storage.from(BUCKET_NAME).list(ROOT_FOLDER);
        if (folders) {
            for (const folder of folders) {
                if (folder.name === '.emptyFolderPlaceholder') continue;
                const path = `${ROOT_FOLDER}/${folder.name}`;
                const { data: files } = await supabase.storage.from(BUCKET_NAME).list(path);
                if (files?.length) {
                    await supabase.storage.from(BUCKET_NAME).remove(files.map(f => `${path}/${f.name}`));
                }
            }
        }
    } catch (err) {
        console.error('清理错误:', err.message);
    }
});
