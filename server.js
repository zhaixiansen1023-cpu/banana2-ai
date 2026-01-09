const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const port = process.env.PORT || 3000;

// --- 环境变量检查 ---
const requiredEnv = ['API_KEY', 'SUPABASE_URL', 'SUPABASE_SERVICE_KEY'];
const missingEnv = requiredEnv.filter(key => !process.env[key]);
if (missingEnv.length > 0) {
    console.error(`❌ 严重错误: 缺少环境变量: ${missingEnv.join(', ')}`);
    // 注意：不要在生产环境直接退出，防止服务不断重启，但功能会失效
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
    // '你的项目.vercel.app' 
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

app.get('/', (req, res) => res.send('Z-AI Server: Secure & Billing Active'));

// --- 核心：带扣费逻辑的代理接口 ---
app.post('/api/proxy', async (req, res) => {
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
        // 根据模型ID判断扣费，防止前端传假价格
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
            // 区分是余额不足还是系统错误
            if (creditError.message && creditError.message.includes('积分不足')) {
                return res.status(402).json({ error: { message: "余额不足，请充值" } });
            }
            return res.status(500).json({ error: { message: "积分系统异常" } });
        }

        // --- 5. 扣费成功，才允许调用 AI ---
        const apiKey = process.env.API_KEY;
        const response = await fetch("https://api.tu-zi.com/v1/images/generations", {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`
            },
            body: JSON.stringify(reqBody)
        });

        const data = await response.json();

        // 如果 API 调用失败（比如参数错误），应该把积分退回去！(进阶逻辑)
        if (response.status !== 200) {
            console.warn("AI 生成失败，正在退款...");
            await supabase.rpc('increment_credits', { count: cost, x_user_id: user.id }); // 需在 SQL 创建此函数
            return res.status(response.status).json(data);
        }
        
        res.status(200).json(data);

    } catch (error) {
        console.error("Proxy Error:", error);
        res.status(500).json({ error: { message: "服务器内部错误" } });
    }
});

// 处理前端路由
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(port, () => {
    console.log(`Server running on port ${port}`);
});
