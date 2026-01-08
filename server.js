const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const path = require('path');

const app = express();
const port = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json({ limit: '50mb' })); 
app.use(cors());

app.post('/api/proxy', async (req, res) => {
    try {
        const apiKey = process.env.API_KEY; 
        if (!apiKey) {
            console.error("❌ 错误: 未配置 API Key");
            return res.status(500).json({ error: { message: "Server: API Key missing" } });
        }

        console.log("🔄 开始转发请求...");

        const response = await fetch("https://api.tu-zi.com/v1/images/generations", {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`
            },
            body: JSON.stringify(req.body)
        });

        console.log(`📡 上游响应状态: ${response.status}`);

        // 如果上游报错（比如400参数错误，429额度不足），我们先读取错误信息返回给前端
        if (!response.ok) {
            const errorText = await response.text();
            console.error("❌ 上游错误详情:", errorText);
            try {
                // 尝试解析成 JSON 返回
                return res.status(response.status).json(JSON.parse(errorText));
            } catch (e) {
                // 如果不是 JSON，直接返回文本
                return res.status(response.status).json({ error: { message: `Upstream Error: ${errorText}` } });
            }
        }

        // ✅ 关键修改：使用管道流 (Pipe) 转发数据
        // 这就像接水管一样，数据来了直接流给前端，不占用服务器内存
        response.body.pipe(res);

    } catch (error) {
        console.error("💥 代理服务器严重错误:", error);
        // 如果 header 还没发出去，才发送 500
        if (!res.headersSent) {
            res.status(500).json({ error: { message: "Server Connection Error" } });
        }
    }
});

app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(port, () => {
    console.log(`🚀 Server running on port ${port}`);
});
