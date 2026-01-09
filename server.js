const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const path = require('path');

const app = express();
const port = process.env.PORT || 3000;

// --- 🛡️ 安全配置区域 (关键) ---
// 把你部署后的域名填在这里。
// 如果你在 Zeabur 部署，就填 Zeabur 给你的那个域名。
// 比如：'z-ai-project.zeabur.app'
const ALLOWED_HOSTS = [
    'localhost',              // 允许本地开发
    '127.0.0.1',             // 允许本地开发
    'zhaixiansen.zeabur.app', // ⚠️ 请替换成你实际的域名
];

// 1. 配置 CORS (跨域资源共享)
// 这一步是告诉浏览器，只有白名单里的网站才有资格发起请求
const corsOptions = {
    origin: function (origin, callback) {
        // 如果没有 origin (比如服务器端请求) 或者 origin 在白名单里，就允许
        if (!origin || ALLOWED_HOSTS.some(host => origin.includes(host))) {
            callback(null, true);
        } else {
            console.log("拦截了一个非法跨域请求:", origin);
            callback(new Error('Not allowed by CORS'));
        }
    }
};

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json({ limit: '50mb' })); // 允许大图片上传
app.use(cors(corsOptions)); // 启用上面配置的安全规则

// 健康检查接口
app.get('/', (req, res) => {
    res.send('Z先森.AI Server is Running (Secure Mode)!');
});

app.post('/api/proxy', async (req, res) => {
    try {
        // 2. 二次安全检查 (Referer/Origin 校验)
        // 这是为了防止有人虽不在浏览器，但用代码强行调你的接口
        const referer = req.get('Referer') || '';
        const origin = req.get('Origin') || '';
        
        // 检查请求头里是否包含你的域名
        const isAllowed = ALLOWED_HOSTS.some(host => 
            referer.includes(host) || origin.includes(host)
        );

        // 如果既不是本地调试，来源也不对，直接拒绝
        if (!isAllowed && !req.hostname.includes('localhost')) {
            return res.status(403).json({ error: { message: "安全拦截: 非法请求来源" } });
        }

        // --- 以下是原有的业务逻辑 ---
        
        // 从环境变量获取 Key (记得在 Zeabur/Vercel 后台设置 API_KEY 变量)
        const apiKey = process.env.API_KEY;
        if (!apiKey) {
            return res.status(500).json({ error: { message: "Server: API Key not configured" } });
        }

        // 转发请求给兔子API
        const response = await fetch("https://api.tu-zi.com/v1/images/generations", {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`
            },
            body: JSON.stringify(req.body)
        });

        const data = await response.json();
        
        // 把结果原封不动传回给前端
        res.status(response.status).json(data);

    } catch (error) {
        console.error("Proxy Error:", error);
        res.status(500).json({ error: { message: "Server Request Failed" } });
    }
});

// 处理所有其他页面请求 (SPA支持)
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(port, () => {
    console.log(`Server running on port ${port}`);
    console.log(`Allowed Hosts: ${ALLOWED_HOSTS.join(', ')}`);
});
