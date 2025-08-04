require('dotenv').config();
const express = require('express');
const axios = require('axios');
const Redis = require('redis');
const logger = require('./logger');
const path = require('path');
const fs = require('fs').promises;
const session = require('express-session');
const app = express();
const cors = require('cors');

// 增加请求体的大小限制，设置为 10mb
const bodyParser = require('body-parser');
app.use(bodyParser.json({ limit: '10mb' }));
app.use(bodyParser.urlencoded({ limit: '10mb', extended: true }));

// 配置express-session
app.use(session({
    secret: process.env.SESSION_SECRET || 'your-secret-key',
    resave: false,
    saveUninitialized: true
}));

// 配置模板引擎
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '../views'));

// 静态文件服务
app.use(express.static(path.join(__dirname, '../public')));

// Redis客户端
const redisClient = Redis.createClient({
    url: `redis://${process.env.REDIS_HOST}:${process.env.REDIS_PORT}`
});

// 连接Redis
(async () => {
    try {
        await redisClient.connect();
        logger.info('Successfully connected to Redis');
    } catch (error) {
        logger.error('Failed to connect to Redis:', error);
        process.exit(1);
    }
})();

// API密钥池
const API_KEYS = process.env.OPENROUTER_API_KEYS.split(',');
logger.info(`Loaded ${API_KEYS.length} API keys`);

// 允许所有来源跨域（开发环境推荐，生产环境建议指定 origin）
app.use(cors({
    origin: '*', // 或者指定 ['http://10.0.0.232:47334'] 更安全
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));

// 中间件
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// 请求日志中间件
app.use((req, res, next) => {
    const start = Date.now();
    res.on('finish', () => {
        const duration = Date.now() - start;
        logger.info({
            method: req.method,
            path: req.path,
            status: res.statusCode,
            duration: `${duration}ms`,
            ip: req.ip
        });
    });
    next();
});

// 获取可用的API密钥
async function getAvailableApiKey() {
    for (const key of API_KEYS) {
        const minuteCount = await redisClient.get(`${key}:minute`);
        const dayCount = await redisClient.get(`${key}:day`);

        // 如果分钟计数达到20或天计数达到200，跳过这个key
        if ((minuteCount && parseInt(minuteCount) >= 20) ||
            (dayCount && parseInt(dayCount) >= 200)) {
            logger.debug(`Skipping key ${key.substring(0, 10)}... (minute: ${minuteCount}, day: ${dayCount})`);
            continue;
        }

        logger.debug(`Selected API key: ${key.substring(0, 10)}... (minute: ${minuteCount}, day: ${dayCount})`);
        return key;
    }
    logger.warn('No available API keys found');
    return null;
}

// 更新API使用计数
async function updateApiKeyUsage(key) {
    try {
        // 计算次日0点的时间戳
        const now = new Date();
        const tomorrow = new Date(now);
        tomorrow.setDate(tomorrow.getDate() + 1);
        tomorrow.setHours(0, 0, 0, 0);
        const secondsUntilTomorrow = Math.floor((tomorrow - now) / 1000);

        const minuteKey = `${key}:minute`;
        const dayKey = `${key}:day`;

        // 使用原子操作增加计数
        const minuteCount = await redisClient.incr(minuteKey);
        const dayCount = await redisClient.incr(dayKey);

        // 检查是否超出限制
        if (minuteCount > 20 || dayCount > 200) {
            // 如果超出限制，回滚计数
            if (minuteCount > 20) {
                await redisClient.decr(minuteKey);
                logger.warn(`Minute limit exceeded for key ${key.substring(0, 10)}..., rolling back`);
            }
            if (dayCount > 200) {
                await redisClient.decr(dayKey);
                logger.warn(`Daily limit exceeded for key ${key.substring(0, 10)}..., rolling back`);
            }
            throw new Error('Rate limit exceeded');
        }

        // 设置过期时间
        if (await redisClient.ttl(minuteKey) < 0) {
            await redisClient.expire(minuteKey, 60);
        }
        if (await redisClient.ttl(dayKey) < 0) {
            await redisClient.expire(dayKey, secondsUntilTomorrow);
        }

        logger.debug(`Updated usage for key ${key.substring(0, 10)}... (minute: ${minuteCount}/20, day: ${dayCount}/200, expires at ${tomorrow.toISOString()})`);
    } catch (error) {
        logger.error('Error updating API key usage:', error);
        throw error;
    }
}

// 处理OpenRouter API请求
app.post('/api/v1/chat/completions', async (req, res) => {
    try {
        const apiKey = await getAvailableApiKey();
        if (!apiKey) {
            logger.warn('All API keys have reached their rate limits');
            return res.status(429).json({
                error: {
                    message: "All API keys have reached their rate limits",
                    code: 429
                }
            });
        }

        // 检查是否请求流式响应
        const isStreaming = req.body.stream === true;

        logger.info(`Making ${isStreaming ? 'streaming' : 'normal'} request to OpenRouter with key ${apiKey.substring(0, 10)}...`);

        if (isStreaming) {
            // 设置 SSE 响应头
            res.setHeader('Content-Type', 'text/event-stream');
            res.setHeader('Cache-Control', 'no-cache');
            res.setHeader('Connection', 'keep-alive');

            const response = await axios({
                method: 'post',
                url: 'https://openrouter.ai/api/v1/chat/completions',
                headers: {
                    'Authorization': `Bearer ${apiKey}`,
                    'Content-Type': 'application/json',
                    'Accept': 'text/event-stream',
                    'HTTP-Referer': 'https://github.com/fengqiaozhu/openrouter-free-pool',
                    'X-Title': 'OpenRouter Free Pool'
                },
                data: req.body,
                responseType: 'stream'
            });

            // 处理流式响应
            let buffer = '';
            response.data.on('data', async chunk => {
                buffer += chunk.toString();
                const lines = buffer.split('\n');
                // 保留最后一行，因为它可能是不完整的
                buffer = lines.pop() || '';



                for (const line of lines) {
                    if (line.trim() === '') continue;
                    if (line.includes('data: [DONE]')) {
                        res.write('data: [DONE]\n\n');
                        continue;
                    }
                    if (line.startsWith('data: ')) {
                        try {
                            const data = line.slice(6); // 移除 'data: ' 前缀
                            if (data.trim() && data.trim() !== '[DONE]') {
                                // 验证JSON格式完整性
                                if (!data.trim().startsWith('{') || !data.trim().endsWith('}')) {
                                    throw new Error('Incomplete JSON data');
                                }
                                const parsed = JSON.parse(data);

                                // 验证JSON结构是否完整且有效
                                if (!parsed || typeof parsed !== 'object') {
                                    throw new Error('Invalid JSON structure');
                                }

                                // 检查是否是限流错误
                                if (parsed.error?.code === 429) {
                                    const errorMessage = parsed.error.message;
                                    const resetTimestamp = parseInt(parsed.error.metadata?.headers?.['X-RateLimit-Reset'] || '0');
                                    logger.warn(`Rate limit exceeded for key ${apiKey.substring(0, 10)}...`);

                                    if (resetTimestamp) {
                                        const now = Date.now();
                                        const ttlSeconds = Math.max(1, Math.floor((resetTimestamp - now) / 1000));

                                        if (errorMessage.includes('free-models-per-day')) {
                                            await redisClient.setEx(`${apiKey}:day`, ttlSeconds, "200");
                                            logger.info(`Marked key ${apiKey.substring(0, 10)}... as daily limit reached, will reset in ${ttlSeconds}s`);
                                        } else if (errorMessage.includes('free-models-per-minute')) {
                                            await redisClient.setEx(`${apiKey}:minute`, ttlSeconds, "20");
                                            logger.info(`Marked key ${apiKey.substring(0, 10)}... as minute limit reached, will reset in ${ttlSeconds}s`);
                                        }
                                    } else {
                                        // 如果没有重置时间戳，使用默认值
                                        if (errorMessage.includes('free-models-per-day')) {
                                            await redisClient.setEx(`${apiKey}:day`, 86400, "200");
                                            logger.info(`Marked key ${apiKey.substring(0, 10)}... as daily limit reached (using default TTL)`);
                                        } else if (errorMessage.includes('free-models-per-minute')) {
                                            await redisClient.setEx(`${apiKey}:minute`, 60, "20");
                                            logger.info(`Marked key ${apiKey.substring(0, 10)}... as minute limit reached (using default TTL)`);
                                        }
                                    }
                                }

                                // 直接发送原始数据，避免 JSON.stringify 的额外转义
                                res.write(`data: ${data}\n\n`);
                            }
                        } catch (e) {
                            // 如果JSON解析失败，说明数据不完整或格式错误，跳过此数据块
                            logger.debug(`SSE数据块JSON解析失败，跳过此数据块。错误: ${e.message}，数据: ${line.substring(0, 100)}...`);
                        }
                    }
                }
            });

            response.data.on('end', async () => {
                await updateApiKeyUsage(apiKey);
                res.end();
            });

            // 处理客户端断开连接
            req.on('close', () => {
                response.data.destroy();
            });
        } else {
            // 非流式请求处理
            const response = await axios({
                method: 'post',
                url: 'https://openrouter.ai/api/v1/chat/completions',
                headers: {
                    'Authorization': `Bearer ${apiKey}`,
                    'Content-Type': 'application/json',
                    'HTTP-Referer': 'https://github.com/fengqiaozhu/openrouter-free-pool',
                    'X-Title': 'OpenRouter Free Pool'
                },
                data: {
                    ...req.body,
                    response_format: { type: "text" }
                }
            });

            // 检查响应中是否包含限流错误
            if (response.data?.error?.code === 429) {
                const errorMessage = response.data.error.message;
                const resetTimestamp = parseInt(response.data.error.metadata?.headers?.['X-RateLimit-Reset'] || '0');
                logger.warn(`Rate limit exceeded for key ${apiKey.substring(0, 10)}...`);

                if (resetTimestamp) {
                    const now = Date.now();
                    const ttlSeconds = Math.max(1, Math.floor((resetTimestamp - now) / 1000));

                    if (errorMessage.includes('free-models-per-day')) {
                        await redisClient.setEx(`${apiKey}:day`, ttlSeconds, "200");
                        logger.info(`Marked key ${apiKey.substring(0, 10)}... as daily limit reached, will reset in ${ttlSeconds}s`);
                    } else if (errorMessage.includes('free-models-per-minute')) {
                        await redisClient.setEx(`${apiKey}:minute`, ttlSeconds, "20");
                        logger.info(`Marked key ${apiKey.substring(0, 10)}... as minute limit reached, will reset in ${ttlSeconds}s`);
                    }
                } else {
                    // 如果没有重置时间戳，使用默认值
                    if (errorMessage.includes('free-models-per-day')) {
                        await redisClient.setEx(`${apiKey}:day`, 86400, "200");
                        logger.info(`Marked key ${apiKey.substring(0, 10)}... as daily limit reached (using default TTL)`);
                    } else if (errorMessage.includes('free-models-per-minute')) {
                        await redisClient.setEx(`${apiKey}:minute`, 60, "20");
                        logger.info(`Marked key ${apiKey.substring(0, 10)}... as minute limit reached (using default TTL)`);
                    }
                }

                return res.status(429).json(response.data);
            }

            await updateApiKeyUsage(apiKey);
            logger.debug('Successfully processed request');

            // 处理响应内容中的转义字符
            if (typeof response.data === 'object' && response.data.choices && response.data.choices[0]) {
                const content = response.data.choices[0].message?.content;
                const reasoning = response.data.choices[0].message?.reasoning;

                if (content) {
                    response.data.choices[0].message.content = content.replaceAll('\\n', '\n');
                }
                if (reasoning) {
                    response.data.choices[0].message.reasoning = reasoning.replaceAll('\\n', '\n');
                }
            }

            // 直接发送原始响应数据
            res.json(response.data);
        }
    } catch (error) {
        logger.error('Error processing request:', {
            message: error.message,
            stack: error.stack,
            response: error.response?.data,
            status: error.response?.status
        });

        // 如果是JSON解析错误，提供更具体的错误信息
        if (error.message.includes('EOF') || error.message.includes('JSON')) {
            return res.status(400).json({
                error: {
                    message: "Invalid JSON format in request or response",
                    code: 400,
                    details: error.message
                }
            });
        }

        res.status(error.response?.status || 500).json(error.response?.data || {
            error: {
                message: "Internal server error",
                code: 500
            }
        });
    }
});

// 健康检查端点
app.get('/health', (req, res) => {
    logger.debug('Health check requested');
    res.json({ status: 'ok' });
});

// 查询API密钥状态端点
app.get('/api/v1/keys/status', async (req, res) => {
    try {
        const results = [];
        for (const key of API_KEYS) {
            const minuteCount = await redisClient.get(`${key}:minute`);
            const dayCount = await redisClient.get(`${key}:day`);

            // 获取剩余时间
            const minuteTTL = await redisClient.ttl(`${key}:minute`);
            const dayTTL = await redisClient.ttl(`${key}:day`);

            results.push({
                key: `${key.substring(0, 10)}...`,  // 只显示前10位
                minute: {
                    used: minuteCount ? parseInt(minuteCount) : 0,
                    remaining: minuteCount ? Math.max(0, 20 - parseInt(minuteCount)) : 20,
                    resetIn: minuteTTL > 0 ? minuteTTL : null
                },
                day: {
                    used: dayCount ? parseInt(dayCount) : 0,
                    remaining: dayCount ? Math.max(0, 200 - parseInt(dayCount)) : 200,
                    resetIn: dayTTL > 0 ? dayTTL : null
                },
                available: (!minuteCount || parseInt(minuteCount) < 20) &&
                    (!dayCount || parseInt(dayCount) < 200)
            });
        }

        const totalAvailable = results.filter(r => r.available).length;

        res.json({
            total_keys: API_KEYS.length,
            available_keys: totalAvailable,
            keys: results
        });
    } catch (error) {
        logger.error('Error fetching keys status:', error);
        res.status(500).json({
            error: {
                message: "Failed to fetch keys status",
                code: 500
            }
        });
    }
});

// 管理页面路由
app.get('/admin', async (req, res) => {
    try {
        // 获取API密钥状态
        const keyStatus = await Promise.all(API_KEYS.map(async (key) => {
            const minuteCount = await redisClient.get(`${key}:minute`);
            const dayCount = await redisClient.get(`${key}:day`);
            const minuteTTL = await redisClient.ttl(`${key}:minute`);
            const dayTTL = await redisClient.ttl(`${key}:day`);

            return {
                key: `${key.substring(0, 10)}...`,
                minute: {
                    used: minuteCount ? parseInt(minuteCount) : 0,
                    remaining: minuteCount ? Math.max(0, 20 - parseInt(minuteCount)) : 20,
                    resetIn: minuteTTL > 0 ? minuteTTL : null
                },
                day: {
                    used: dayCount ? parseInt(dayCount) : 0,
                    remaining: dayCount ? Math.max(0, 200 - parseInt(dayCount)) : 200,
                    resetIn: dayTTL > 0 ? dayTTL : null
                },
                available: (!minuteCount || parseInt(minuteCount) < 20) &&
                    (!dayCount || parseInt(dayCount) < 200)
            };
        }));

        // 读取最近的日志
        const logs = await readRecentLogs();

        // 计算统计信息
        const stats = {
            total_keys: API_KEYS.length,
            available_keys: keyStatus.filter(k => k.available).length,
            total_requests: await getTotalRequests(),
            error_rate: await getErrorRate()
        };

        res.render('admin', {
            keys: keyStatus,
            logs: logs,
            stats: stats,
            message: req.session.message
        });

        // 清除消息
        delete req.session.message;
    } catch (error) {
        logger.error('Error rendering admin page:', error);
        res.status(500).send('Internal Server Error');
    }
});

// 添加新的API密钥
app.post('/admin/keys/add', async (req, res) => {
    try {
        const newKey = req.body.apiKey;
        if (!newKey) {
            req.session.message = { type: 'danger', text: 'API key is required' };
            return res.redirect('/admin');
        }

        // 验证密钥格式
        if (!newKey.startsWith('sk-')) {
            req.session.message = { type: 'danger', text: 'Invalid API key format' };
            return res.redirect('/admin');
        }

        // 检查密钥是否已存在
        if (API_KEYS.includes(newKey)) {
            req.session.message = { type: 'danger', text: 'API key already exists' };
            return res.redirect('/admin');
        }

        // 更新环境变量
        const newKeys = [...API_KEYS, newKey];
        await updateEnvFile('OPENROUTER_API_KEYS', newKeys.join(','));

        // 更新内存中的密钥
        API_KEYS.push(newKey);

        req.session.message = { type: 'success', text: 'API key added successfully' };
        res.redirect('/admin');
    } catch (error) {
        logger.error('Error adding API key:', error);
        req.session.message = { type: 'danger', text: 'Failed to add API key' };
        res.redirect('/admin');
    }
});

// 删除API密钥
app.post('/admin/keys/delete', async (req, res) => {
    try {
        const keyToDelete = req.body.apiKey;
        if (!keyToDelete) {
            req.session.message = { type: 'danger', text: 'API key is required' };
            return res.redirect('/admin');
        }

        // 从数组中移除密钥
        const index = API_KEYS.findIndex(k => k.startsWith(keyToDelete.split('...')[0]));
        if (index === -1) {
            req.session.message = { type: 'danger', text: 'API key not found' };
            return res.redirect('/admin');
        }

        const fullKey = API_KEYS[index];
        API_KEYS.splice(index, 1);

        // 更新环境变量
        await updateEnvFile('OPENROUTER_API_KEYS', API_KEYS.join(','));

        // 清除Redis中的相关数据
        await redisClient.del(`${fullKey}:minute`);
        await redisClient.del(`${fullKey}:day`);

        req.session.message = { type: 'success', text: 'API key deleted successfully' };
        res.redirect('/admin');
    } catch (error) {
        logger.error('Error deleting API key:', error);
        req.session.message = { type: 'danger', text: 'Failed to delete API key' };
        res.redirect('/admin');
    }
});

// 获取最新日志
app.get('/admin/logs', async (req, res) => {
    try {
        const logs = await readRecentLogs();
        res.json({ logs });
    } catch (error) {
        logger.error('Error fetching logs:', error);
        res.status(500).json({ error: 'Failed to fetch logs' });
    }
});

// 辅助函数：读取最近的日志
async function readRecentLogs(limit = 100) {
    try {
        const logFile = path.join(__dirname, '../logs/combined.log');
        const content = await fs.readFile(logFile, 'utf8');
        return content
            .split('\n')
            .filter(Boolean)
            .slice(-limit)
            .map(line => {
                try {
                    const log = JSON.parse(line);
                    return {
                        timestamp: log.timestamp,
                        level: log.level,
                        message: log.message
                    };
                } catch (e) {
                    return null;
                }
            })
            .filter(Boolean)
            .reverse();
    } catch (error) {
        logger.error('Error reading logs:', error);
        return [];
    }
}

// 辅助函数：获取24小时内的总请求数
async function getTotalRequests() {
    try {
        const logFile = path.join(__dirname, '../logs/combined.log');
        const content = await fs.readFile(logFile, 'utf8');
        const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;

        return content
            .split('\n')
            .filter(Boolean)
            .filter(line => {
                try {
                    const log = JSON.parse(line);
                    return new Date(log.timestamp).getTime() > oneDayAgo &&
                        log.path === '/api/v1/chat/completions';
                } catch (e) {
                    return false;
                }
            })
            .length;
    } catch (error) {
        logger.error('Error counting requests:', error);
        return 0;
    }
}

// 辅助函数：获取24小时内的错误率
async function getErrorRate() {
    try {
        const logFile = path.join(__dirname, '../logs/combined.log');
        const content = await fs.readFile(logFile, 'utf8');
        const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;

        const logs = content
            .split('\n')
            .filter(Boolean)
            .filter(line => {
                try {
                    const log = JSON.parse(line);
                    return new Date(log.timestamp).getTime() > oneDayAgo &&
                        log.path === '/api/v1/chat/completions';
                } catch (e) {
                    return false;
                }
            });

        const totalRequests = logs.length;
        if (totalRequests === 0) return 0;

        const errorRequests = logs.filter(line => {
            try {
                const log = JSON.parse(line);
                return log.status >= 400;
            } catch (e) {
                return false;
            }
        }).length;

        return Math.round((errorRequests / totalRequests) * 100);
    } catch (error) {
        logger.error('Error calculating error rate:', error);
        return 0;
    }
}

// 辅助函数：更新环境变量文件
async function updateEnvFile(key, value) {
    try {
        const envFile = path.join(__dirname, '../.env');
        let content = await fs.readFile(envFile, 'utf8');

        const regex = new RegExp(`^${key}=.*$`, 'm');
        if (content.match(regex)) {
            content = content.replace(regex, `${key}=${value}`);
        } else {
            content += `\n${key}=${value}`;
        }

        await fs.writeFile(envFile, content);
    } catch (error) {
        logger.error('Error updating .env file:', error);
        throw error;
    }
}

// 启动服务器
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    logger.info(`Server is running on port ${PORT}`);
});
