const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const path = require('path');

const app = express();
const port = process.env.PORT || 3000;

// 1. 关键：开启静态文件服务，否则打不开网页
app.use(express.static(path.join(__dirname, 'public')));

// 2. 关键：允许 50mb 大小的图片传输，否则上传参考图会报错
app.use(express.json({ limit: '50mb' })); 
app.use(cors());

// 3. 核心接口：名字叫 /api/proxy
app.post('/api/proxy', async (req, res) => {
    try {
        const apiKey = process.env.API_KEY; 
        if (!apiKey) {
            console.error("Missing API Key");
            return res.status(500).json({ error: { message: "Server: API Key not configured" } });
        }

        // 转发给兔子API
        const response = await fetch("https://api.tu-zi.com/v1/images/generations", {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`
            },
            body: JSON.stringify(req.body)
        });

        const data = await response.json();
        
        // 无论成功失败，都把上游的状态码透传回去
        res.status(response.status).json(data);

    } catch (error) {
        console.error("Proxy Error:", error);
        res.status(500).json({ error: { message: "Server internal proxy error" } });
    }
});

// 4. 兜底路由：任何其他请求都返回网页
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(port, () => {
    console.log(`Server running on port ${port}`);
});
