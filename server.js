const cron = require('node-cron');
const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const https = require('https');

const app = express();
const port = process.env.PORT || 3000;

// --- 环境变量检查 ---
const requiredEnv = ['API_KEY', 'SUPABASE_URL', 'SUPABASE_SERVICE_KEY'];
const missingEnv = requiredEnv.filter(key => !process.env[key]);
if (missingEnv.length > 0) {
    console.error(`❌ 严重错误: 缺少环境变量: ${missingEnv.join(', ')}`);
}

// 初始化 Supabase 管理员客户端 (用于后端扣费)
const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY // ⚠️ 必须是 Service Role Key
);

// --- 忽略 SSL 证书错误 (专治 api.tu-zi.com 证书报错) ---
const ignoreSSL = new https.Agent({
    rejectUnauthorized: false
});

// --- 安全域名白名单 ---
const ALLOWED_HOSTS = [
    'localhost',
    '127.0.0.1',
    'zhaixiansen.zeabur.app', // 你的 Zeabur 域名
];

const corsOptions = {
    origin: function (origin, callback) {
        if (!origin || ALLOWED_HOSTS.some(host => origin.includes(host))) {
            callback(null, true);
        } else {
            console.log("拦截跨域:", origin);
            callback(new Error('Not allowed by CORS'));
        }
    }
};

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json({ limit: '50mb' }));
app.use(cors(corsOptions));

app.get('/', (req, res) => res.send('Z-AI Server: Stable V8.0 (Sync Fixed)'));

// ==========================================
// 核心：生图接口 (同步/异步 分流处理)
// ==========================================
app.post('/api/proxy', async (req, res) => {
    let userForRefund = null;
    let costForRefund = 0;

    try {
        // 1. 鉴权
        const authHeader = req.headers.authorization;
        if (!authHeader) return res.status(401).json({ error: { message: "未登录" } });
        const token = authHeader.split(' ')[1];
        const { data: { user }, error: authError } = await supabase.auth.getUser(token);
        if (authError || !user) return res.status(403).json({ error: { message: "身份验证失败" } });

        // 2. 准备参数
        let { model, prompt, size, n, response_format } = req.body;
        
        // 判定：是否为异步模型 (只要名字里带 async)
        const isAsync = model && model.includes('async');

        // 3. 扣费逻辑
        let cost = 5; // 默认 1k 价格
        if (model && model.includes('4k')) cost = 15;
        else if (model && model.includes('2k')) cost = 10;

        console.log(`用户 ${user.email} 请求生成 (${isAsync ? '异步' : '同步'}), model=${model}, size=${size}`);

        const { error: creditError } = await supabase.rpc('decrement_credits', { count: cost, x_user_id: user.id });
        if (creditError) return res.status(402).json({ error: { message: "余额不足" } });

        userForRefund = user;
        costForRefund = cost;

        const apiKey = process.env.API_KEY;
        let response;

        // =================================================
        // 🔀 分流处理：异步走左边，同步走右边
        // =================================================
        if (isAsync) {
            // --- 🍌 异步通道 (Multipart + 参数修正) ---
            
            // 修正尺寸为比例 (异步专用)
            // 如果传进来是 1024x1024 这种像素，强制转为比例
            if (!size || size.includes('x')) {
                if (size === '1792x1024') size = '16:9';
                else if (size === '1024x1792') size = '9:16';
                else size = '1:1';
            }

            // 手动构建 Multipart/form-data (支持中文)
            const boundary = '----WebKitFormBoundary' + Math.random().toString(36).substring(2);
            const parts = [];
            const addField = (name, value) => {
                parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n`));
                parts.push(Buffer.from(String(value)));
                parts.push(Buffer.from('\r\n'));
            };

            addField('model', model);
            addField('prompt', prompt);
            addField('size', size);

            parts.push(Buffer.from(`--${boundary}--`));
            const bodyBuffer = Buffer.concat(parts);

            // 发送给 /videos 接口
            response = await fetch("https://api.tu-zi.com/v1/videos", { 
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${apiKey}`,
                    'Content-Type': `multipart/form-data; boundary=${boundary}`,
                    'Content-Length': bodyBuffer.length
                },
                body: bodyBuffer,
                agent: ignoreSSL
            });

        } else {
            // --- 🛡️ 同步通道 (纯净 JSON，恢复旧逻辑) ---
            
            // 确保尺寸是像素 (同步专用)
            // 如果前端传了 16:9 这种比例，强制转回像素
            if (size === '16:9') size = '1792x1024';
            else if (size === '3:4' || size === '9:16') size = '1024x1792';
            else if (size === '1:1') size = '1024x1024';

            // 发送给 /images/generations 接口 (标准 OpenAI 格式)
            response = await fetch("https://api.tu-zi.com/v1/images/generations", { 
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${apiKey}`
                },
                body: JSON.stringify({ 
                    model, 
                    prompt, 
                    size, 
                    n: 1, 
                    response_format: "b64_json" // 强制要求返回 Base64，方便前端保存
                }), 
                agent: ignoreSSL
            });
        }

        // 5. 错误处理
        if (!response.ok) {
            const errText = await response.text();
            console.error(`API Error (${response.status}):`, errText);
            
            // 自动退款
            await supabase.rpc('increment_credits', { count: costForRefund, x_user_id: userForRefund.id });
            
            return res.status(response.status).json({ 
                error: { message: "服务商报错" }, 
                details: errText 
            });
        }

        const data = await response.json();
        res.status(200).json(data);

    } catch (error) {
        console.error("System Error:", error);
        // 系统级错误退款
        if (userForRefund) await supabase.rpc('increment_credits', { count: costForRefund, x_user_id: userForRefund.id });
        res.status(500).json({ error: { message: "服务器内部错误" } });
    }
});

// --- 查询任务接口 (抗崩版) ---
app.get('/api/proxy/tasks/:id', async (req, res) => {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader) return res.status(401).json({ error: { message: "未登录" } });
        
        const taskId = req.params.id;
        const apiKey = process.env.API_KEY;

        const response = await fetch(`https://api.tu-zi.com/v1/videos/${taskId}`, {
            method: 'GET',
            headers: { 'Authorization': `Bearer ${apiKey}` },
            agent: ignoreSSL
        });

        // 🟢 关键修复：先判断状态码，防止解析 Bad Gateway 报错
        const contentType = response.headers.get("content-type");
        if (!response.ok || !contentType || !contentType.includes("application/json")) {
            console.warn(`Upstream Error (${response.status})`);
            // 返回一个 JSON 让前端知道要重试，而不是崩掉
            return res.status(200).json({ status: "RETRY", error: "Upstream busy" });
        }

        const data = await response.json();
        
        // 数据标准化 (清洗数据，让前端统一处理)
        let standardData = { status: "PROCESSING" };
        
        if (data.status === 'completed' || data.status === 'SUCCESS') {
            standardData.status = 'SUCCESS';
            // 兼容不同字段名：video_url 或 url
            standardData.output = { url: data.video_url || data.url };
        } else if (data.status === 'failed' || data.status === 'FAILED') {
            standardData.status = 'FAILED';
            standardData.error = data.error || "任务失败";
        } else {
            standardData.status = data.status || "queued";
            standardData.progress = data.progress;
        }

        res.status(200).json(standardData);

    } catch (error) {
        console.error("Task Query Error:", error);
        // 出错也返回 JSON，防止前端崩
        res.status(200).json({ status: "RETRY" }); 
    }
});

// 处理前端路由
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(port, () => {
    console.log(`Server running on port ${port} - V8.0 Sync/Async Fixed`);
});

// --- 定时任务：每天凌晨 00:00 清理 temp 文件夹 ---
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

        console.log(`✅ 清理完成！共删除了 ${totalFilesDeleted} 张临时图片。`);

    } catch (err) {
        console.error('❌ 清理失败:', err.message);
    }
});
