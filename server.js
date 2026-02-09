const cron = require('node-cron');
const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const https = require('https'); // 🟢 新增：引入 https 模块

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

// 🟢 新增：创建一个“忽略 SSL 证书错误”的代理 (专治 api.tu-zi.com 证书报错)
const ignoreSSL = new https.Agent({
    rejectUnauthorized: false
});

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json({ limit: '50mb' }));
app.use(cors(corsOptions));

app.get('/', (req, res) => res.send('Z-AI Server: Secure & Billing Active (Patched)'));

// --- 核心：智能代理接口 (已适配 Async Banana 格式) ---
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
        const { model, prompt, size, n, response_format } = req.body;
        
        // 判断是否为特殊的异步模型
        const isAsyncBanana = model && model.includes('async');

        // 3. 计算扣费
        let cost = 5;
        if (model.includes('4k')) cost = 15;
        else if (model.includes('2k')) cost = 10;

        // 4. 执行扣费
        const { error: creditError } = await supabase.rpc('decrement_credits', { count: cost, x_user_id: user.id });
        if (creditError) return res.status(402).json({ error: { message: "余额不足" } });

        userForRefund = user;
        costForRefund = cost;

        // 5. 发送请求给供应商
        const apiKey = process.env.API_KEY;
        let response;

        if (isAsyncBanana) {
            // ==========================================
            // 🍌 针对异步香蕉格式的特殊处理 (Multipart)
            // ==========================================
            const boundary = '----WebKitFormBoundary' + Math.random().toString(36).substring(2);
            
            // 手动构建 multipart/form-data body
            let bodyParts = [];
            
            // 添加文本字段
            const appendField = (name, value) => {
                bodyParts.push(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`);
            };
            
            appendField('model', model);
            appendField('prompt', prompt);
            appendField('size', size); // 这里前端传来的已经是 "16:9" 格式了

            // 如果有参考图 (从 prompt 里提取 --sref 链接，或者简单处理)
            // 这里为了简化，我们暂时只处理纯文本生成。
            // 如果你需要带图，逻辑会复杂很多，目前先保证文字生图跑通。

            bodyParts.push(`--${boundary}--`);

            response = await fetch("https://api.tu-zi.com/v1/videos", { // 🟢 注意：这里变成了 /videos
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${apiKey}`,
                    'Content-Type': `multipart/form-data; boundary=${boundary}`
                },
                body: bodyParts.join(''),
                agent: ignoreSSL
            });

        } else {
            // ==========================================
            // 🛡️ 原有的 OpenAI 格式处理 (JSON)
            // ==========================================
            response = await fetch("https://api.tu-zi.com/v1/images/generations", {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${apiKey}`
                },
                body: JSON.stringify(req.body),
                agent: ignoreSSL
            });
        }

        if (!response.ok) {
            const errText = await response.text();
            console.error("Provider Error:", errText);
            // 失败退款
            await supabase.rpc('increment_credits', { count: costForRefund, x_user_id: userForRefund.id });
            return res.status(response.status).json({ error: { message: "服务商报错，积分已退回" }, details: errText });
        }

        const data = await response.json();
        
        // 🟢 修正返回格式：让前端能统一识别 id
        // 香蕉格式返回的是 { id: "...", status: "queued" ... }
        // OpenAI 格式返回的是 { data: [...] }
        res.status(200).json(data);

    } catch (error) {
        console.error("System Error:", error);
        if (userForRefund) await supabase.rpc('increment_credits', { count: costForRefund, x_user_id: userForRefund.id });
        res.status(500).json({ error: { message: "服务器内部错误" } });
    }
});

// --- 🟢 升级：查询异步任务状态 (适配 /videos/{id}) ---
app.get('/api/proxy/tasks/:id', async (req, res) => {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader) return res.status(401).json({ error: { message: "未登录" } });
        const token = authHeader.split(' ')[1];
        
        // 简单鉴权
        const { data: { user }, error } = await supabase.auth.getUser(token);
        if (error || !user) return res.status(403).json({ error: { message: "无效用户" } });

        const taskId = req.params.id;
        const apiKey = process.env.API_KEY;

        // 🟢 智能路由：根据 ID 格式或尝试逻辑决定去哪个接口
        // 香蕉文档说查询路径是 /v1/videos/{id}
        // 为了保险，我们直接请求 /videos 接口，因为我们在 POST 里用的就是它
        const response = await fetch(`https://api.tu-zi.com/v1/videos/${taskId}`, {
            method: 'GET',
            headers: { 'Authorization': `Bearer ${apiKey}` },
            agent: ignoreSSL
        });

        const data = await response.json();

        // 🟢 数据清洗：把香蕉的返回格式转换成前端能看懂的通用格式
        // 香蕉返回: { status: "completed", video_url: "..." }
        // 前端期待: { status: "SUCCESS", output: { url: "..." } }
        
        let standardData = { status: "PROCESSING" }; // 默认处理中

        if (data.status === 'completed') {
            standardData.status = 'SUCCESS';
            standardData.output = { url: data.video_url }; // 映射 video_url 到 url
        } else if (data.status === 'failed') {
            standardData.status = 'FAILED';
            standardData.error = "任务生成失败";
        } else {
            standardData.status = data.status; // queued, processing 等
        }

        res.status(200).json(standardData);

    } catch (error) {
        console.error("Task Query Error:", error);
        res.status(500).json({ error: { message: "查询失败" } });
    }
});
// 处理前端路由
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(port, () => {
    console.log(`Server running on port ${port} - V7.1 SSL修复版`); // 👈 改这里
});

// 设置定时任务：每天凌晨 00:00 执行
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


