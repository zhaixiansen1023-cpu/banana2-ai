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
// 🔍 1. 启动检查与数据库连接 (防崩溃处理)
// ==================================================================
let supabase = null; // 先设为空，防止初始化失败导致程序崩溃

const requiredEnv = ['API_KEY', 'SUPABASE_URL', 'SUPABASE_SERVICE_KEY'];
const missingEnv = requiredEnv.filter(key => !process.env[key]);

// 如果缺变量，只报错，不崩溃
if (missingEnv.length > 0) {
    console.error(`\n❌❌❌ [启动警告] 缺少环境变量: ${missingEnv.join(', ')} ❌❌❌`);
    console.error(`请在 Zeabur 环境变量设置中添加它们。在添加之前，生成功能将无法使用。\n`);
} else {
    // 只有变量全的时候才尝试连接
    try {
        supabase = createClient(
            process.env.SUPABASE_URL,
            process.env.SUPABASE_SERVICE_KEY
        );
        console.log('✅ Supabase 数据库连接成功');
    } catch (err) {
        console.error('❌ Supabase 初始化失败:', err.message);
    }
}

// 忽略 SSL 证书错误 (针对某些 API 证书问题)
const ignoreSSL = new https.Agent({ rejectUnauthorized: false });

// 允许所有跨域 (方便调试)
const corsOptions = { origin: (o, c) => c(null, true) };

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json({ limit: '50mb' }));
app.use(cors(corsOptions));

// 健康检查接口
app.get('/', (req, res) => res.send('Z-AI Proxy Server is Running...'));

// ==================================================================
// 🟢 2. 模型注册表
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
// 🟢 3. 统一调度接口
// ==================================================================
app.post('/api/proxy', async (req, res) => {
    // 🚨 第一道防线：如果服务器没连上数据库，直接拦截
    if (!supabase) {
        return res.status(500).json({ 
            error: { message: "服务器环境变量未配置，无法连接数据库。" } 
        });
    }

    let userForRefund = null;
    let costForRefund = 0;

    try {
        // 1. 身份验证
        const authHeader = req.headers.authorization;
        if (!authHeader) return res.status(401).json({ error: { message: "No Token" } });
        const { data: { user }, error: authError } = await supabase.auth.getUser(authHeader.split(' ')[1]);
        if (authError || !user) return res.status(403).json({ error: { message: "Invalid Token" } });

        // 2. 查表
        const modelName = req.body.model;
        const config = MODEL_REGISTRY[modelName] || MODEL_REGISTRY['default'];
        
        const cost = config.cost;
        costForRefund = cost;
        userForRefund = user;

        console.log(`🤖 Model: ${modelName} | Mode: ${config.type.toUpperCase()} | User: ${user.email}`);

        // 3. 扣费
        const { error: creditError } = await supabase.rpc('decrement_credits', { count: cost, x_user_id: user.id });
        if (creditError) return res.status(402).json({ error: { message: "积分不足" } });

        // 4. 分流处理
        let resultUrl = "";
        
        if (config.type === 'async') {
            resultUrl = await handleAsyncGeneration(req.body, config.path);
        } else {
            resultUrl = await handleSyncGeneration(req.body, config.path, user.id);
        }

        res.status(200).json({
            created: Date.now(),
            data: [{ url: resultUrl }]
        });

    } catch (error) {
        console.error("❌ Error:", error.message);
        // 自动退款
        if (userForRefund && supabase) {
            await supabase.rpc('increment_credits', { count: costForRefund, x_user_id: userForRefund.id });
        }
        res.status(500).json({ error: { message: error.message || "Server Error" } });
    }
});

// ==================================================================
// 🔵 4. 异步引擎
// ==================================================================
async function handleAsyncGeneration(body, apiPath) {
    const baseUrl = "https://api.tu-zi.com";
    
    // 提交任务
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
            throw new Error("生成失败");
        }
    }
    throw new Error("生成超时");
}

// ==================================================================
// 🟠 5. 同步引擎
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
        // 如果是 Base64，且数据库连接正常，才转存
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

// 前端路由
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(port, () => console.log(`✅ 服务器已启动 (Port ${port})`));

// ==================================================================
// 🧹 6. 自动清理任务 (完整逻辑)
// ==================================================================
cron.schedule('0 0 * * *', async () => {
    if (!supabase) return;
    console.log('🕒 [自动任务] 开始深度清理 temp 文件夹...');

    const BUCKET_NAME = 'ai-images'; 
    const ROOT_FOLDER = 'temp';

    try {
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

        for (const folder of userFolders) {
            if (folder.name === '.emptyFolderPlaceholder') continue;
            const userFolderPath = `${ROOT_FOLDER}/${folder.name}`;
            
            const { data: files } = await supabase
                .storage
                .from(BUCKET_NAME)
                .list(userFolderPath);

            if (files && files.length > 0) {
                const pathsToDelete = files.map(f => `${userFolderPath}/${f.name}`);
                const { error: removeError } = await supabase
                    .storage
                    .from(BUCKET_NAME)
                    .remove(pathsToDelete);
                
                if (!removeError) {
                    totalFilesDeleted += pathsToDelete.length;
                }
            }
        }
        console.log(`✅ 清理完成！共删除了 ${totalFilesDeleted} 张临时图片。`);
    } catch (err) {
        console.error('❌ 清理失败:', err.message);
    }
});
