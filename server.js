const cron = require('node-cron');
const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const https = require('https');

// ==================================================================
// 🟢 1. 模型注册表 (以后换模型，只改这里！)
// ==================================================================
const MODEL_REGISTRY = {
    // --- 异步模型 (对应 /v1/videos 路径) ---
    'gemini-3-pro-image-preview-async':    { type: 'async', path: '/v1/videos', cost: 5 },
    'gemini-3-pro-image-preview-2k-async': { type: 'async', path: '/v1/videos', cost: 10 },
    'gemini-3-pro-image-preview-4k-async': { type: 'async', path: '/v1/videos', cost: 15 },

    // --- 同步模型 (对应 /v1/images/generations) ---
    // 如果你想用 DALL-E 3，可以在这里开启
    'gemini-3-pro-image-preview':          { type: 'sync',  path: '/v1/images/generations', cost: 5 },
    'dall-e-3':                            { type: 'sync',  path: '/v1/images/generations', cost: 20 },
    
    // --- 默认配置 (防崩) ---
    'default':                             { type: 'async', path: '/v1/videos', cost: 5 }
};

const app = express();
const port = process.env.PORT || 3000;

// --- 环境变量检查 ---
const requiredEnv = ['API_KEY', 'SUPABASE_URL', 'SUPABASE_SERVICE_KEY'];
if (requiredEnv.some(key => !process.env[key])) {
    console.error("❌ 严重错误: 缺少环境变量");
}

// 初始化 Supabase
const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
);

// 忽略 SSL 证书错误 (针对某些 API 证书问题)
const ignoreSSL = new https.Agent({ rejectUnauthorized: false });

// 允许所有跨域 (方便调试)
const corsOptions = { origin: (o, c) => c(null, true) };

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json({ limit: '50mb' }));
app.use(cors(corsOptions));

app.get('/', (req, res) => res.send('Z-AI Universal Proxy Running (V7.3 Complete)...'));

// ==================================================================
// 🟢 2. 统一调度接口 (The Manager)
// ==================================================================
app.post('/api/proxy', async (req, res) => {
    let userForRefund = null;
    let costForRefund = 0;

    try {
        // 1. 身份验证
        const authHeader = req.headers.authorization;
        if (!authHeader) return res.status(401).json({ error: { message: "No Token" } });
        const { data: { user }, error: authError } = await supabase.auth.getUser(authHeader.split(' ')[1]);
        if (authError || !user) return res.status(403).json({ error: { message: "Invalid Token" } });

        // 2. 查表决定处理方式
        const modelName = req.body.model;
        const config = MODEL_REGISTRY[modelName] || MODEL_REGISTRY['default'];
        
        const cost = config.cost;
        costForRefund = cost;
        userForRefund = user;

        console.log(`🤖 Model: ${modelName} | Mode: ${config.type.toUpperCase()} | Cost: ${cost}`);

        // 3. 扣费
        const { error: creditError } = await supabase.rpc('decrement_credits', { count: cost, x_user_id: user.id });
        if (creditError) return res.status(402).json({ error: { message: "积分不足，请充值" } });

        // 4. 分流处理
        let resultUrl = "";
        
        if (config.type === 'async') {
            // 走异步轮询通道
            resultUrl = await handleAsyncGeneration(req.body, config.path);
        } else {
            // 走同步直连通道 (带 Base64 转存功能)
            resultUrl = await handleSyncGeneration(req.body, config.path, user.id);
        }

        // 5. 返回统一格式
        res.status(200).json({
            created: Date.now(),
            data: [{ url: resultUrl }]
        });

    } catch (error) {
        console.error("❌ Proxy Error:", error.message);
        // 自动退款
        if (userForRefund) {
            console.log(`💸 执行退款: ${costForRefund} 积分`);
            await supabase.rpc('increment_credits', { count: costForRefund, x_user_id: userForRefund.id });
        }
        res.status(500).json({ error: { message: error.message || "Server Error" } });
    }
});

// ==================================================================
// 🔵 3. 异步处理引擎 (Async Engine)
// ==================================================================
async function handleAsyncGeneration(body, apiPath) {
    const baseUrl = "https://api.tu-zi.com";
    
    // 提交任务
    // 注意：如果是异步模型，我们忽略 body.images，因为新接口暂时不支持传图
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

    // 轮询等待
    let attempts = 0;
    while (attempts < 60) { // 最多等 2 分钟
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
    throw new Error("生成超时，请稍后重试");
}

// ==================================================================
// 🟠 4. 同步处理引擎 (Sync Engine)
// ==================================================================
async function handleSyncGeneration(body, apiPath, userId) {
    const baseUrl = "https://api.tu-zi.com"; 

    // 尺寸转换
    let sizeParam = "1024x1024";
    if (body.size === "16:9") sizeParam = "1792x1024";
    else if (body.size === "3:4") sizeParam = "1024x1792";

    // 构造 Payload (支持垫图)
    const payload = {
        model: body.model,
        prompt: body.prompt,
        size: sizeParam,
        n: 1,
        response_format: "url"
    };

    // 如果前端传了图片 (images 数组)，且不为空，我们就把它塞进 prompt 或者对应字段
    // 注意：Gemini 的同步接口处理图片的方式可能不同，这里仅作基础透传示例
    // 具体的 API 如果支持 'input_image' 或 'image' 字段，请按需修改
    // 目前大部分同步绘图 API (DALL-E 3) 不支持垫图，但如果有，这里可以扩展

    const res = await fetch(`${baseUrl}${apiPath}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.API_KEY}` },
        body: JSON.stringify(payload),
        agent: ignoreSSL
    });

    if (!res.ok) throw new Error(`生成失败: ${await res.text()}`);
    const data = await res.json();
    
    // 优先找 URL，如果没有，找 b64_json 并转存
    if (data.data && data.data.length > 0) {
        const item = data.data[0];
        if (item.url) return item.url;

        if (item.b64_json) {
            console.log("⚠️ API 返回 Base64，正在转存...");
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

    throw new Error("API 返回的数据格式无法识别");
}

// 前端路由
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(port, () => console.log(`Universal Proxy running on port ${port}`));

// ==================================================================
// 🧹 5. 自动清理任务 (已完整恢复)
// ==================================================================
cron.schedule('0 0 * * *', async () => {
    console.log('🕒 [自动任务] 开始深度清理 temp 文件夹...');

    const BUCKET_NAME = 'ai-images'; 
    const ROOT_FOLDER = 'temp';

    try {
        // 1. 先列出 temp 下面有哪些“用户文件夹”
        const { data: userFolders, error: listError } = await supabase
            .storage
            .from(BUCKET_NAME)
            .list(ROOT_FOLDER);

        if (listError) throw listError;

        if (!userFolders || userFolders.length === 0) {
            console.log('✅ temp 文件夹已经是空的。');
            return;
        }

        let totalFilesDeleted = 0;

        // 2. 遍历每一个“用户文件夹”，把里面的图片找出来
        for (const folder of userFolders) {
            // 跳过占位符文件
            if (folder.name === '.emptyFolderPlaceholder') continue;

            const userFolderPath = `${ROOT_FOLDER}/${folder.name}`;
            
            // 钻进文件夹找图片
            const { data: files } = await supabase
                .storage
                .from(BUCKET_NAME)
                .list(userFolderPath);

            if (files && files.length > 0) {
                const pathsToDelete = files.map(f => `${userFolderPath}/${f.name}`);
                
                // 执行删除
                const { error: removeError } = await supabase
                    .storage
                    .from(BUCKET_NAME)
                    .remove(pathsToDelete);
                
                if (!removeError) {
                    totalFilesDeleted += pathsToDelete.length;
                }
            }
        }

        console.log(`✅ 清理完成！共删除了 ${totalFilesDeleted} 张临时图片，所有空文件夹已自动消失。`);

    } catch (err) {
        console.error('❌ 清理失败:', err.message);
    }
});
