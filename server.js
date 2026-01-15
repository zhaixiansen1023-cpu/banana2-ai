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

// --- 核心：带扣费逻辑的代理接口 ---
app.post('/api/proxy', async (req, res) => {
    // 定义变量用于后续可能的退款
    let userForRefund = null;
    let costForRefund = 0;

    try {
        // 1. 身份验证：从请求头里拿 Token
        const authHeader = req.headers.authorization;
        if (!authHeader) {
            return res.status(401).json({ error: { message: "未登录：缺少 Authorization 头" } });
        }
        const token = authHeader.split(' ')[1]; // 去掉 "Bearer " 前缀

        // 2. 向 Supabase 核实用户身份
        const { data: { user }, error: authError } = await supabase.auth.getUser(token);
        
        if (authError || !user) {
            return res.status(403).json({ error: { message: "身份验证失败，Token 无效" } });
        }

        // 3. 计算扣费金额 (根据画质参数)
        const reqBody = req.body;
        let cost = 5; // 默认 1k 价格
        if (reqBody.model && reqBody.model.includes('4k')) cost = 15;
        else if (reqBody.model && reqBody.model.includes('2k')) cost = 10;

        console.log(`用户 ${user.email} 请求生成，预计扣费: ${cost}`);

        // 4. 执行扣费 (调用数据库 RPC 函数)
        const { error: creditError } = await supabase.rpc('decrement_credits', {
            count: cost,
            x_user_id: user.id
        });

        if (creditError) {
            console.error("扣费失败:", creditError);
            if (creditError.message && creditError.message.includes('积分不足')) {
                return res.status(402).json({ error: { message: "余额不足，请充值" } });
            }
            return res.status(500).json({ error: { message: "积分系统异常" } });
        }

        // 记录下来，如果后面 API 调用崩了，好把钱退给人家
        userForRefund = user;
        costForRefund = cost;

        // --- 5. 扣费成功，才允许调用 AI ---
        const apiKey = process.env.API_KEY;
        const response = await fetch("https://api.tu-zi.com/v1/images/generations", {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`
            },
            body: JSON.stringify(reqBody),
            agent: ignoreSSL // 🟢 新增：强制忽略 SSL 证书报错
        });

        // 🟢 新增：防崩坏逻辑
        // 先检查对方状态码，如果不是 200 OK，千万别解析 JSON，否则会报错 "Unexpected token B"
        if (!response.ok) {
            const errorText = await response.text(); // 以文本形式读取错误
            console.error(`❌ 供应商报错 (${response.status}):`, errorText);

            // 💰 自动退款逻辑：供应商挂了，必须把积分退给用户
            if (userForRefund) {
                console.warn(`正在为用户 ${userForRefund.email} 执行退款: ${costForRefund} 积分...`);
                await supabase.rpc('increment_credits', { count: costForRefund, x_user_id: userForRefund.id });
            }
            
            // 把错误原样扔回给前端，自己别崩
            return res.status(response.status).json({
                error: { message: `供应商服务异常 (${response.status})，积分已自动退回。` },
                details: errorText.substring(0, 200) 
            });
        }

        const data = await response.json();
        res.status(200).json(data);

    } catch (error) {
        console.error("Proxy Error:", error);
        
        // 💰 发生代码级异常（如网络中断），也要退款
        if (userForRefund) {
            console.warn(`系统异常，执行退款: ${costForRefund} 积分...`);
            await supabase.rpc('increment_credits', { count: costForRefund, x_user_id: userForRefund.id });
        }

        res.status(500).json({ error: { message: "服务器内部错误，积分已退回" } });
    }
});

// 处理前端路由
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(port, () => {
    console.log(`Server running on port ${port}`);
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
