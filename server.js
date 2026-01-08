const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const path = require('path');

const app = express();
const port = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json({ limit: '50mb' })); // 允许大图片上传
app.use(cors());

// 健康检查接口（用来确认服务器活着）
app.get('/', (req, res) => {
    res.send('Z先森.AI Server is Running!');
});

app.post('/api/proxy', async (req, res) => {
    try {
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

        // 关键改动：不再用 pipe，而是直接解析 JSON
        // 这样虽然占点内存，但兼容性最好，绝不会 502
        const data = await response.json();
        
        // 把结果原封不动传回给前端
        res.status(response.status).json(data);

    } catch (error) {
        console.error("Proxy Error:", error);
        res.status(500).json({ error: { message: "Server Request Failed" } });
    }
});

// 处理所有其他页面请求
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(port, () => {
    console.log(`Server running on port ${port}`);
});
