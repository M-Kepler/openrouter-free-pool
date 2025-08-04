const express = require('express');
const router = express.Router();
const ApiService = require('../services/apiService');

module.exports = (apiService) => {
    // 处理聊天完成请求
    router.post('/chat/completions', async (req, res) => {
        await apiService.handleChatCompletions(req, res);
    });

    // 健康检查端点
    router.get('/health', (req, res) => {
        res.json({ status: 'ok' });
    });

    // 查询API密钥状态端点
    router.get('/keys/status', async (req, res) => {
        try {
            const status = await apiService.keyService.getKeysStatus();
            res.json(status);
        } catch (error) {
            res.status(500).json({
                error: {
                    message: "Failed to fetch keys status",
                    code: 500
                }
            });
        }
    });

    return router;
};
