const axios = require('axios');
const FormData = require('form-data');
const cron = require('node-cron');
const express = require('express');
const cors = require('cors');
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

// 通用 HTTPS Agent (关闭 KeepAlive 以防 EOF)
const httpsAgent = new https.Agent({ 
    rejectUnauthorized: false,
    keepAlive: false 
});

const corsOptions = { origin: (o, c) => c(null, true) };

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json({ limit: '50mb' })); 
app.use(cors(corsOptions));

app.get('/', (req, res) => res.send('Z-AI Proxy Server Running (Hybrid Mode)...'));

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
// 🛠️ 3. 辅助函数：上传 Base64 到 Supabase 并获取 URL
// ==================================================================
async function uploadToSupabaseAndGetUrl(base64Str, userId) {
    if (!supabase || !base64Str) return null;
    try {
        const matches = base64Str.match(/^data:(.+);base64,(.+)$/);
        if (!matches) return null;
        
        const mimeType = matches[1];
        const buffer = Buffer.from(matches[2], 'base64');
        const ext = mimeType.split('/')[1] || 'png';
        const fileName = `uploads/${userId}/${Date.now()}_input.${ext}`;

        // 上传
        const { error: uploadError } = await supabase.storage
            .from('ai-images')
            .upload(fileName, buffer, { contentType: mimeType, upsert: true });

        if (uploadError) throw uploadError;

        // 获取公开链接
        const { data } = supabase.storage.from('ai-images').getPublicUrl(fileName);
        return data.publicUrl;
    } catch (e) {
        console.error("⚠️ Supabase 上传失败，降级为直接传文件:", e.message);
        return null;
    }
}

// ==================================================================
// 🔵 4. 异步引擎 (双保险策略)
// ==================================================================
async function handleAsyncGeneration(body, apiPath, userId) {
    const baseUrl = "https://api.tu-zi.com";
    let inputImageUrl = null;

    // 策略 A: 尝试上传到 Supabase 并使用 URL 方式 (最稳定)
    if (body.images && body.images.length > 0 && supabase) {
        console.log("🔄 正在尝试策略 A: 上传图片到 Supabase 获取 URL...");
        inputImageUrl = await uploadToSupabaseAndGetUrl(body.images[0], userId);
    }

    if (inputImageUrl) {
        // === 方案一：发送 JSON + URL (绕过 Multipart 坑) ===
        console.log("✅ 策略 A 成功，发送 JSON 请求...");
        const payload = {
            model: body.model,
            prompt: body.prompt,
            size: body.size || "16:9",
            image: inputImageUrl,     // 兼容字段 1
            image_url: inputImageUrl, // 兼容字段 2
            file_url: inputImageUrl   // 兼容字段 3
        };

        try {
            const res = await axios.post(`${baseUrl}${apiPath}`, payload, {
                headers: { 
                    'Authorization': `Bearer ${process.env.API_KEY}`,
                    'Content-Type': 'application/json' 
                },
                httpsAgent
            });
            return processAsyncResponse(res.data, baseUrl, apiPath);
        } catch (e) {
            console.warn("⚠️ 策略 A (JSON+URL) 失败，尝试策略 B (Multipart)...", e.message);
            // 失败则继续执行下方的 方案二
        }
    }

    // === 方案二：Axios + FormData (最后一道防线) ===
    console.log("🔄 正在尝试策略 B: 直接发送文件流 (Multipart)...");
    
    const form = new FormData();
    form.append('model', body.model);
    form.append('prompt', body.prompt);
    form.append('size', body.size || "16:9");

    if (body.images && body.images.length > 0) {
        body.images.forEach((imgStr, index) => {
            if (typeof imgStr === 'string' && imgStr.startsWith('data:')) {
                const matches = imgStr.match(/^data:(.+);base64,(.+)$/);
                if (matches) {
                    const buffer = Buffer.from(matches[2], 'base64');
                    // 必须提供 knownLength，否则 axios 计算 Content-Length 可能出错
                    form.append('image', buffer, { 
                        filename: `image_${index}.png`,
                        contentType: matches[1],
                        knownLength: buffer.length 
                    });
                }
            }
        });
    }

    try {
        const res = await axios.post(`${baseUrl}${apiPath}`, form, {
            headers: {
                'Authorization': `Bearer ${process.env.API_KEY}`,
                ...form.getHeaders() // 让 form-data 生成完美的 Boundary
            },
            httpsAgent,
            maxBodyLength: Infinity,
            maxContentLength: Infinity
        });
        return processAsyncResponse(res.data, baseUrl, apiPath);
    } catch (error) {
        const errMsg = error.response ? JSON.stringify(error.response.data) : error.message;
        throw new Error(`策略 B 也失败了: ${errMsg}`);
    }
}

// 辅助：处理异步响应
async function processAsyncResponse(taskData, baseUrl, apiPath) {
    const taskId = taskData.id || taskData.data?.id;
    if (!taskId) throw new Error(`API返回无效: ${JSON.stringify(taskData)}`);

    let attempts = 0;
    while (attempts < 60) {
        await new Promise(r => setTimeout(r, 2000));
        attempts++;
        
        const checkRes = await axios.get(`${baseUrl}${apiPath}/${taskId}`, {
            headers: { 'Authorization': `Bearer ${process.env.API_KEY}` },
            httpsAgent
        });
        
        const statusData = checkRes.data;
        if (statusData.status === 'completed' || statusData.status === 'succeeded') {
            return statusData.video_url || statusData.url || (statusData.images && statusData.images[0]?.url);
        } else if (statusData.status === 'failed') {
            throw new Error(`任务失败: ${JSON.stringify(statusData)}`);
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
            // 传入 userId 以便上传 Supabase
            resultUrl = await handleAsyncGeneration(req.body, config.path, user.id);
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
// 🟠 6. 同步引擎 (Axios 版)
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

    try {
        const res = await axios.post(`${baseUrl}${apiPath}`, payload, {
            headers: { 
                'Content-Type': 'application/json', 
                'Authorization': `Bearer ${process.env.API_KEY}` 
            },
            httpsAgent
        });

        const data = res.data;
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

    } catch (error) {
         if (error.response) {
            throw new Error(`同步接口错误 [${error.response.status}]: ${JSON.stringify(error.response.data)}`);
        }
        throw error;
    }
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
