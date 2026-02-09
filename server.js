// ❌ 彻底弃用 axios, form-data, node-fetch 等中间商
const https = require('https'); // 使用原生 HTTPS 模块
const { URL } = require('url');
const cron = require('node-cron');
const express = require('express');
const cors = require('cors');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const port = process.env.PORT || 8080;

// ==================================================================
// 🔍 1. 启动检查与数据库连接
// ==================================================================
let supabase = null;
const requiredEnv = ['API_KEY', 'SUPABASE_URL', 'SUPABASE_SERVICE_KEY'];
const missingEnv = requiredEnv.filter(key => !process.env[key]);

if (missingEnv.length > 0) {
    console.error(`\n❌❌❌ [启动警告] 缺少环境变量: ${missingEnv.join(', ')}`);
} else {
    try {
        supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
        console.log('✅ Supabase 数据库连接成功');
    } catch (err) {
        console.error('❌ Supabase 初始化失败:', err.message);
    }
}

const corsOptions = { origin: (o, c) => c(null, true) };

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json({ limit: '50mb' })); 
app.use(cors(corsOptions));

app.get('/', (req, res) => res.send('Z-AI Proxy Server Running (Native HTTPS Mode)...'));

// ==================================================================
// 🟢 2. 模型配置
// ==================================================================
const MODEL_REGISTRY = {
    'gemini-3-pro-image-preview-async':    { type: 'async', path: '/v1/videos', cost: 5 },
    'gemini-3-pro-image-preview-2k-async': { type: 'async', path: '/v1/videos', cost: 10 },
    'gemini-3-pro-image-preview-4k-async': { type: 'async', path: '/v1/videos', cost: 15 },
    'gemini-3-pro-image-preview':          { type: 'sync',  path: '/v1/images/generations', cost: 5 },
    'dall-e-3':                            { type: 'sync',  path: '/v1/images/generations', cost: 20 },
    'default':                             { type: 'async', path: '/v1/videos', cost: 5 }
};

// ==================================================================
// 🛠️ 3. [核弹级] 原生 Multipart 构建器 (精准控制每一个字节)
// ==================================================================
function buildMultipartBuffer(fields, files) {
    const boundary = '----ZeaburNativeBoundary' + Date.now().toString(16);
    const CRLF = '\r\n';
    const chunks = [];

    // 1. 添加普通字段
    for (const [key, value] of Object.entries(fields)) {
        chunks.push(Buffer.from(`--${boundary}${CRLF}`));
        chunks.push(Buffer.from(`Content-Disposition: form-data; name="${key}"${CRLF}${CRLF}`));
        chunks.push(Buffer.from(`${value}${CRLF}`));
    }

    // 2. 添加文件字段
    if (files && files.length > 0) {
        files.forEach((file) => {
            chunks.push(Buffer.from(`--${boundary}${CRLF}`));
            // 注意：filename 是必须的
            chunks.push(Buffer.from(`Content-Disposition: form-data; name="image"; filename="${file.filename}"${CRLF}`));
            chunks.push(Buffer.from(`Content-Type: ${file.mimeType}${CRLF}${CRLF}`));
            chunks.push(file.buffer); // 直接拼入二进制 Buffer
            chunks.push(Buffer.from(CRLF)); // 文件后必须跟一个换行
        });
    }

    // 3. 结束边界 (注意结尾的 --)
    chunks.push(Buffer.from(`--${boundary}--${CRLF}`));

    return {
        boundary,
        buffer: Buffer.concat(chunks)
    };
}

// ==================================================================
// 🛠️ 4. [核弹级] 原生 HTTPS 请求发送器
// ==================================================================
function nativePostRequest(urlStr, headers, bodyBuffer) {
    return new Promise((resolve, reject) => {
        const url = new URL(urlStr);
        const options = {
            hostname: url.hostname,
            port: 443,
            path: url.pathname + url.search,
            method: 'POST',
            headers: headers,
            rejectUnauthorized: false, // 忽略 SSL 错误
            agent: false // 不使用连接池，强制短连接
        };

        const req = https.request(options, (res) => {
            const chunks = [];
            res.on('data', (d) => chunks.push(d));
            res.on('end', () => {
                const body = Buffer.concat(chunks).toString();
                if (res.statusCode >= 200 && res.statusCode < 300) {
                    try {
                        resolve(JSON.parse(body));
                    } catch (e) {
                        resolve(body); // 如果不是JSON，返回文本
                    }
                } else {
                    reject(new Error(`API Error [${res.statusCode}]: ${body}`));
                }
            });
        });

        req.on('error', (e) => {
            reject(new Error(`Network Error: ${e.message}`));
        });

        // 写入数据并结束请求
        if (bodyBuffer) {
            req.write(bodyBuffer);
        }
        req.end();
    });
}

function nativeGetRequest(urlStr, headers) {
    return new Promise((resolve, reject) => {
        const url = new URL(urlStr);
        const options = {
            hostname: url.hostname,
            port: 443,
            path: url.pathname + url.search,
            method: 'GET',
            headers: headers,
            rejectUnauthorized: false
        };

        const req = https.request(options, (res) => {
            const chunks = [];
            res.on('data', (d) => chunks.push(d));
            res.on('end', () => {
                const body = Buffer.concat(chunks).toString();
                try {
                    resolve(JSON.parse(body));
                } catch (e) {
                    resolve(body);
                }
            });
        });
        req.on('error', reject);
        req.end();
    });
}

// ==================================================================
// 🔵 5. 异步引擎 (调用原生发送器)
// ==================================================================
async function handleAsyncGeneration(body, apiPath) {
    const fullUrl = `https://api.tu-zi.com${apiPath}`;
    
    // 1. 准备文件数据
    const files = [];
    if (body.images && body.images.length > 0) {
        body.images.forEach((imgStr, index) => {
            if (typeof imgStr === 'string' && imgStr.startsWith('data:')) {
                const matches = imgStr.match(/^data:(.+);base64,(.+)$/);
                if (matches) {
                    files.push({
                        filename: `image_${index}.${matches[1].split('/')[1] || 'png'}`,
                        mimeType: matches[1],
                        buffer: Buffer.from(matches[2], 'base64')
                    });
                }
            }
        });
    }

    // 2. 构建 Payload
    const fields = {
        model: body.model,
        prompt: body.prompt,
        size: body.size || "16:9"
    };

    const { boundary, buffer: payloadBuffer } = buildMultipartBuffer(fields, files);

    // 3. 发送请求
    // 显式设置 Content-Length，彻底解决 EOF 问题
    const headers = {
        'Authorization': `Bearer ${process.env.API_KEY}`,
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': payloadBuffer.length, // 🔥 关键：告诉服务器精确长度
        'Connection': 'close' // 🔥 关键：用完即关
    };

    console.log(`🚀 Sending Native Request: ${payloadBuffer.length} bytes`);
    
    const taskData = await nativePostRequest(fullUrl, headers, payloadBuffer);
    const taskId = taskData.id || (taskData.data && taskData.data.id);

    if (!taskId) throw new Error(`提交成功但无ID: ${JSON.stringify(taskData)}`);

    // 4. 轮询
    let attempts = 0;
    while (attempts < 60) {
        await new Promise(r => setTimeout(r, 2000));
        attempts++;
        
        const checkUrl = `https://api.tu-zi.com${apiPath}/${taskId}`;
        const checkRes = await nativeGetRequest(checkUrl, {
            'Authorization': `Bearer ${process.env.API_KEY}`
        });
        
        if (checkRes.status === 'completed' || checkRes.status === 'succeeded') {
            return checkRes.video_url || checkRes.url || (checkRes.images && checkRes.images[0]?.url);
        } else if (checkRes.status === 'failed') {
            throw new Error(`生成失败: ${JSON.stringify(checkRes)}`);
        }
    }
    throw new Error("生成超时");
}

// ==================================================================
// 🟢 6. 统一调度接口
// ==================================================================
app.post('/api/proxy', async (req, res) => {
    if (!supabase) return res.status(500).json({ error: { message: "数据库未连接" } });

    let userForRefund = null;
    let costForRefund = 0;

    try {
        const authHeader = req.headers.authorization;
        if (!authHeader) return res.status(401).json({ error: { message: "No Token" } });
        
        const { data: { user }, error: authError } = await supabase.auth.getUser(authHeader.split(' ')[1]);
        if (authError || !user) return res.status(403).json({ error: { message: "Invalid Token" } });

        const modelName = req.body.model;
        const config = MODEL_REGISTRY[modelName] || MODEL_REGISTRY['default'];
        
        const cost = config.cost;
        costForRefund = cost;
        userForRefund = user;

        console.log(`🤖 Model: ${modelName} | Mode: ${config.type.toUpperCase()} | User: ${user.email}`);

        const { error: creditError } = await supabase.rpc('decrement_credits', { count: cost, x_user_id: user.id });
        if (creditError) return res.status(402).json({ error: { message: "积分不足" } });

        let resultUrl = "";
        if (config.type === 'async') {
            resultUrl = await handleAsyncGeneration(req.body, config.path);
        } else {
            // 同步接口也尽量使用 native，但为了简单这里只保留之前的逻辑逻辑即可
            // 如果同步也报错，请告诉我，我再改同步
             resultUrl = await handleSyncGeneration(req.body, config.path, user.id);
        }

        res.status(200).json({ created: Date.now(), data: [{ url: resultUrl }] });

    } catch (error) {
        console.error("❌ 处理错误:", error.message);
        if (userForRefund) {
            await supabase.rpc('increment_credits', { count: costForRefund, x_user_id: userForRefund.id });
        }
        res.status(500).json({ error: { message: error.message || "Server Error" } });
    }
});

// ==================================================================
// 🟠 7. 同步引擎 (为了稳妥，这里也用原生 JSON 发送)
// ==================================================================
async function handleSyncGeneration(body, apiPath, userId) {
    const fullUrl = `https://api.tu-zi.com${apiPath}`;
    let sizeParam = "1024x1024";
    if (body.size === "16:9") sizeParam = "1792x1024";
    else if (body.size === "3:4") sizeParam = "1024x1792";

    const payload = JSON.stringify({
        model: body.model,
        prompt: body.prompt,
        size: sizeParam,
        n: 1,
        response_format: "url"
    });

    const headers = {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.API_KEY}`,
        'Content-Length': Buffer.byteLength(payload)
    };

    const data = await nativePostRequest(fullUrl, headers, payload);

    if (data.data && data.data.length > 0) {
        const item = data.data[0];
        if (item.url) return item.url;
        if (item.b64_json && supabase) {
            const buffer = Buffer.from(item.b64_json, 'base64');
            const fileName = `temp/${userId}/sync_${Date.now()}.png`;
            const { error } = await supabase.storage.from('ai-images').upload(fileName, buffer, { contentType: 'image/png' });
            if (error) throw new Error("转存失败");
            const { data: publicData } = supabase.storage.from('ai-images').getPublicUrl(fileName);
            return publicData.publicUrl;
        }
    }
    throw new Error("无法识别返回格式");
}

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(port, () => console.log(`✅ 服务器已启动 (Port ${port})`));

// 自动清理任务
cron.schedule('0 0 * * *', async () => {
    if (!supabase) return;
    try {
        const BUCKET_NAME = 'ai-images'; 
        const ROOT_FOLDER = 'temp';
        const { data: folders } = await supabase.storage.from(BUCKET_NAME).list(ROOT_FOLDER);
        if (folders) {
            for (const folder of folders) {
                if (folder.name === '.emptyFolderPlaceholder') continue;
                const path = `${ROOT_FOLDER}/${folder.name}`;
                const { data: files } = await supabase.storage.from(BUCKET_NAME).list(path);
                if (files?.length) {
                    await supabase.storage.from(BUCKET_NAME).remove(files.map(f => `${path}/${f.name}`));
                }
            }
        }
    } catch (err) {
        console.error('清理错误:', err.message);
    }
});
