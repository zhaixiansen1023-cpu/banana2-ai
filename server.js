const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const path = require('path');

const app = express();
const port = process.env.PORT || 3000;

// 启用静态文件服务，让用户能访问你的HTML
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json({ limit: '50mb' })); // 支持大图片传输
app.use(cors());

// 核心转发逻辑
app.post('/api/proxy', async (req, res) => {
    try {
        const apiKey = process.env.API_KEY; // 这里从环境变量取密码
        if (!apiKey) {
            return res.status(500).json({ error: { message: "服务器未配置API Key" } });
        }

        const response = await fetch("https://api.tu-zi.com/v1/images/generations", {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`
            },
            body: JSON.stringify(req.body)
        });

        // 如果API返回错误（比如额度不够），直接把错误透传给前端
        if (!response.ok) {
            const errData = await response.json();
            return res.status(response.status).json(errData);
        }

        const data = await response.json();
        res.json(data);

    } catch (error) {
        console.error("Proxy Error:", error);
        res.status(500).json({ error: { message: "服务器内部转发错误" } });
    }
});

// 任何其他请求都返回主页
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(port, () => {
    console.log(`Server running on port ${port}`);
});
