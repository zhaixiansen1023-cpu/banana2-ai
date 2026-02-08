const cron = require('node-cron');
const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const https = require('https');

// ==================================================================
// 🟢 1. 模型注册表 (根据文档调整)
// ==================================================================
const MODEL_REGISTRY = {
    // --- 异步模型 (文档 2.1 类似, 对应 /v1/videos 路径) ---
    'gemini-3-pro-image-preview-async':    { type: 'async', path: '/v1/videos', cost: 5 },
    'gemini-3-pro-image-preview-2k-async': { type: 'async', path: '/v1/videos', cost: 10 },
    'gemini-3-pro-image-preview-4k-async': { type: 'async', path: '/v1/videos', cost: 15 },

    // --- 同步模型 (文档 2.2 对应 /v1/images/generations) ---
    // 你可以在这里添加更多支持 OpenAI 格式的模型
    'gemini-3-pro-image-preview':          { type: 'sync',  path: '/v1/images/generations', cost: 5 },
    'dall-e-3':                            { type: 'sync',  path: '/v1/images/generations', cost: 20 },
    
    // --- 默认配置 ---
    'default':                             { type: 'async', path: '/v1/videos', cost: 5 }
};

const app = express();
const port = process.env.PORT || 3000;

// 环境变量检查
const requiredEnv = ['API_KEY', 'SUPABASE_URL', 'SUPABASE_SERVICE_KEY'];
if (requiredEnv.some(key => !process.env[key])) console.error("❌ 缺少环境变量");

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const ignoreSSL = new https.Agent({ rejectUnauthorized: false });

const corsOptions = { origin: (o, c) => c(null, true) };

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json({ limit: '50mb' }));
app.use(cors(corsOptions));

app.get('/', (req, res) => res.send('Z-AI Universal Proxy Running (V7.2 Patched)...'));

// ==================================================================
// 🟢 2. 统一调度接口
// ==================================================================
app.post('/api/proxy', async (req, res) => {
    let userForRefund = null;
    let costForRefund = 0;

    try {
        // --- 鉴权 ---
        const authHeader = req.headers.authorization;
        if (!authHeader) return res.status(401).json({ error: { message: "No Token" } });
        const { data: { user }, error: authError } = await supabase.auth.getUser(authHeader.split(' ')[1]);
        if (authError || !user) return res.status(403).json({ error: { message: "Invalid Token" } });

        // --- 查表 ---
        const modelName = req.body.model;
        const config = MODEL_REGISTRY[modelName] || MODEL_REGISTRY['default'];
        
        const cost = config.cost;
        costForRefund = cost;
        userForRefund = user;

        console.log(`🤖 Model: ${modelName} | Mode: ${config.type.toUpperCase()} | Cost: ${cost}`);

        // --- 扣费 ---
        const { error: creditError } = await supabase.rpc('decrement_credits', { count: cost, x_user_id: user.id });
        if (creditError) return res.status(402).json({ error: { message: "积分不足" } });

        // --- 分流 ---
        let resultUrl = "";
        
        if (config.type === 'async') {
            resultUrl = await handleAsyncGeneration(req.body, config.path);
        } else {
            // 传入 user.id 以便处理 Base64 转存
            resultUrl = await handleSyncGeneration(req.body, config.path, user.id);
        }

        res.status(200).json({ created: Date.now(), data: [{ url: resultUrl }] });

    } catch (error) {
        console.error("❌ Error:", error.message);
        if (userForRefund) await supabase.rpc('increment_credits', { count: costForRefund, x_user_id: userForRefund.id });
        res.status(500).json({ error: { message: error.message || "Server Error" } });
    }
});

// ==================================================================
// 🔵 3. 异步引擎 (Async / Polling)
// ==================================================================
async function handleAsyncGeneration(body, apiPath) {
    const baseUrl = "https://api.tu-zi.com";
    
    // 提交
    const submitRes = await fetch(`${baseUrl}${apiPath}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.API_KEY}` },
        body: JSON.stringify({
            model: body.model,
            prompt: body.prompt,
            size: body.size || "16:9" 
        }),
        agent: ignoreSSL
    });

    if (!submitRes.ok) throw new Error(`提交失败: ${await submitRes.text()}`);
    const taskData = await submitRes.json();
    const taskId = taskData.id;

    // 轮询
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
            throw new Error("API 报告生成失败");
        }
    }
    throw new Error("生成超时");
}

// ==================================================================
// 🟠 4. 同步引擎 (Sync / Direct) - 修复了 Base64 处理
// ==================================================================
async function handleSyncGeneration(body, apiPath, userId) {
    const baseUrl = "https://api.tu-zi.com"; 

    // 尺寸转换
    let sizeParam = "1024x1024";
    if (body.size === "16:9") sizeParam = "1792x1024";
    else if (body.size === "3:4") sizeParam = "1024x1792";

    const payload = {
        model: body.model,
        prompt: body.prompt,
        size: sizeParam,
        n: 1,
        response_format: "url" // 🟢 显式请求 URL，减少 Base64 概率
    };

    const res = await fetch(`${baseUrl}${apiPath}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.API_KEY}` },
        body: JSON.stringify(payload),
        agent: ignoreSSL
    });

    if (!res.ok) throw new Error(`生成失败: ${await res.text()}`);
    const data = await res.json();
    
    // 🟢 增强处理：优先找 URL，如果没有，找 b64_json 并自动转存
    if (data.data && data.data.length > 0) {
        const item = data.data[0];

        // 情况 A: 完美，直接给了 URL
        if (item.url) return item.url;

        // 情况 B: 给了 Base64 (文档里提到的情况)
        if (item.b64_json) {
            console.log("⚠️ API 返回了 Base64，正在转存到 Supabase...");
            const buffer = Buffer.from(item.b64_json, 'base64');
            const fileName = `temp/${userId}/sync_${Date.now()}.png`;
            
            const { error } = await supabase.storage
                .from('ai-images')
                .upload(fileName, buffer, { contentType: 'image/png' });
                
            if (error) throw new Error("Base64 转存失败: " + error.message);
            
            const { data: publicData } = supabase.storage
                .from('ai-images')
                .getPublicUrl(fileName);
                
            return publicData.publicUrl;
        }
    }

    throw new Error("API 返回的数据格式无法识别 (无 url 也无 b64_json)");
}

// 前端路由
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(port, () => console.log(`Universal Proxy running on port ${port}`));

// 自动清理任务
cron.schedule('0 0 * * *', async () => {
    // 你的清理逻辑
});
