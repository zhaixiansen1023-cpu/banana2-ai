import express from 'express';
import cors from 'cors';
import fetch from 'node-fetch';
import path from 'path';
import { fileURLToPath } from 'url';

const app = express();
const port = process.env.PORT || 3000;

// 开启跨域和JSON解析
app.use(cors());
app.use(express.json());
app.use(express.static('public')); // 托管静态网页

// 核心画图接口
app.post('/api/generate', async (req, res) => {
    try {
        const { model, prompt, size, n, response_format } = req.body;
        const apiKey = process.env.AI_API_KEY;
        const apiUrl = process.env.AI_API_URL || "https://api.tu-zi.com/v1/images/generations";

        if (!apiKey) {
            return res.status(500).json({ error: { message: "服务端未配置 API Key" } });
        }

        console.log(`[Server] 收到画图请求: ${prompt.slice(0, 20)}...`);

        // 设置超长超时时间（5分钟），防止 AI 画太慢
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 300000); // 300秒超时

        const response = await fetch(apiUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`
            },
            body: JSON.stringify({ model, prompt, size, n, response_format }),
            signal: controller.signal
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
            const errText = await response.text();
            console.error("[Server] API Error:", errText);
            throw new Error(`上游 API 报错: ${errText}`);
        }

        const data = await response.json();
        res.json(data);

    } catch (error) {
        console.error("[Server] 处理失败:", error);
        res.status(500).json({ error: { message: error.message || "服务器内部错误" } });
    }
});

// 任何其他请求都返回网页
app.get('*', (req, res) => {
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(port, () => {
    console.log(`Server is running on port ${port}`);
});