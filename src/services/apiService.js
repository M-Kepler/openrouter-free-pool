const axios = require('axios');
const logger = require('../logger');

// 限流错误码 429
const rateLimitErrorCode = 429
// 默认重置时间是到第二天8点
const rateLimitTTL = 86400

class ApiService {
    constructor(keyService, redisService) {
        this.keyService = keyService;
        this.redisService = redisService;
    }

    // 处理OpenRouter API请求
    async handleChatCompletions(req, res) {
        try {
            const apiKey = await this.keyService.getAvailableApiKey();
            if (!apiKey) {
                logger.warn('All API keys have reached their rate limits');
                return res.status(rateLimitErrorCode).json({
                    error: {
                        message: "All API keys have reached their rate limits",
                        code: rateLimitErrorCode
                    }
                });
            }

            // 检查是否请求流式响应
            const isStreaming = req.body.stream === true;

            logger.info(`Making ${isStreaming ? 'streaming' : 'normal'} request to OpenRouter with key ${apiKey.substring(0, 10)}...`);

            if (isStreaming) {
                return await this.handleStreamingRequest(req, res, apiKey);
            } else {
                return await this.handleNormalRequest(req, res, apiKey);
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
    }

    // 处理流式请求
    async handleStreamingRequest(req, res, apiKey) {
        // 设置 SSE 响应头
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');

        let response;
        try {
            response = await axios({
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
        } catch (error) {
            logger.error('API request error:', {
                message: error.message,
                // stack: error.stack, // 这个超级多信息的
                response: error.response?.data,
                status: error.response?.status
            });

            // 如果是限流错误
            if (error.response?.status === rateLimitErrorCode) {
                const rateLimitError = error.response.data?.error || {
                    message: "Rate limit exceeded",
                    code: rateLimitErrorCode
                };
                await this.handleRateLimit(rateLimitError, apiKey);
                return res.status(rateLimitErrorCode).json({ error: rateLimitError });
            }

            return res.status(error.response?.status || 500).json(error.response?.data || {
                error: {
                    message: "Internal server error",
                    code: 500
                }
            });
        }

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
                            if (parsed.error?.code === rateLimitErrorCode) {
                                const rateLimitError = parsed.error || {
                                    message: "Rate limit exceeded in streaming",
                                    code: rateLimitErrorCode
                                };
                                await this.handleRateLimit(rateLimitError, apiKey);
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
            await this.keyService.updateApiKeyUsage(apiKey);
            res.end();
        });

        // 处理客户端断开连接
        req.on('close', () => {
            response.data.destroy();
        });
    }

    // 处理普通请求
    async handleNormalRequest(req, res, apiKey) {
        try {
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
            logger.info(JSON.stringify(response, undefined, 4));

            // 检查响应中是否包含限流错误
            if (response.data?.error?.code === rateLimitErrorCode) {
                await this.handleRateLimit(response.data.error, apiKey);
                return res.status(rateLimitErrorCode).json(response.data);
            }

            await this.keyService.updateApiKeyUsage(apiKey);
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
        } catch (error) {
            logger.error('API request error:', {
                message: error.message,
                // stack: error.stack,
                // response: error.response?.data,
                status: error.response?.status
            });

            // 如果是限流错误
            if (error.response?.status === rateLimitErrorCode) {
                await this.handleRateLimit(error.response.data.error, apiKey);
                return res.status(rateLimitErrorCode).json(error.response.data);
            }

            return res.status(error.response?.status || 500).json(error.response?.data || {
                error: {
                    message: "Internal server error",
                    code: 500
                }
            });
        }
    }

    // 处理限流错误
    async handleRateLimit(error, apiKey) {
        if (!error) {
            logger.error('Received undefined error in handleRateLimit');
            return;
        }

        const errorMessage = error.statusMessage || 'Unknown rate limit error';
        const resetTimestamp = parseInt(error.metadata?.headers?.['X-RateLimit-Reset'] || '0');
        logger.warn(`Rate limit exceeded for key ${apiKey}: ${errorMessage}`);

        if (resetTimestamp) {
            const now = Date.now();
            const ttlSeconds = Math.max(1, Math.floor((resetTimestamp - now) / 1000));

            if (errorMessage.includes('free-models-per-day')) {
                await this.redisService.setCounterWithTTL(`${apiKey}:day`, "200", ttlSeconds);
                logger.info(`Marked key ${apiKey.substring(0, 10)}... as daily limit reached, will reset in ${ttlSeconds}s`);
            } else if (errorMessage.includes('free-models-per-minute')) {
                await this.redisService.setCounterWithTTL(`${apiKey}:minute`, "20", ttlSeconds);
                logger.info(`Marked key ${apiKey.substring(0, 10)}... as minute limit reached, will reset in ${ttlSeconds}s`);
            }
        } else {
            // 如果没有重置时间戳，使用默认值
            await this.redisService.setCounterWithTTL(`${apiKey}:day`, "200", rateLimitTTL);
            logger.info(`Marked key ${apiKey.substring(0, 10)}... as daily limit reached (using default TTL)`);
            await this.redisService.setCounterWithTTL(`${apiKey}:minute`, "20", 60);
            logger.info(`Marked key ${apiKey.substring(0, 10)}... as minute limit reached (using default TTL)`);
        }
    }
}

module.exports = ApiService;
