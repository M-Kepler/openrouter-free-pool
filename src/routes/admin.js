const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs').promises;

module.exports = (keyService) => {
    // 管理页面路由
    router.get('/', async (req, res) => {
        try {
            // 获取API密钥状态
            const keyStatus = await Promise.all(keyService.apiKeys.map(async (key) => {
                const minuteCount = await keyService.redis.get(`${key}:minute`);
                const dayCount = await keyService.redis.get(`${key}:day`);
                const minuteTTL = await keyService.redis.ttl(`${key}:minute`);
                const dayTTL = await keyService.redis.ttl(`${key}:day`);

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
                total_keys: keyService.apiKeys.length,
                available_keys: keyStatus.filter(k => k.available).length,
                total_requests: await getTotalRequests(keyService.redis),
                error_rate: await getErrorRate(keyService.redis)
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
            console.error('Error rendering admin page:', error);
            res.status(500).send('Internal Server Error');
        }
    });

    // 添加新的API密钥
    router.post('/keys/add', async (req, res) => {
        try {
            const newKey = req.body.apiKey;
            if (!newKey) {
                req.session.message = { type: 'danger', text: 'API key is required' };
                return res.redirect('/admin');
            }

            try {
                keyService.addApiKey(newKey);
                req.session.message = { type: 'success', text: 'API key added successfully' };
            } catch (error) {
                req.session.message = { type: 'danger', text: error.message };
            }

            res.redirect('/admin');
        } catch (error) {
            console.error('Error adding API key:', error);
            req.session.message = { type: 'danger', text: 'Failed to add API key' };
            res.redirect('/admin');
        }
    });

    // 删除API密钥
    router.post('/keys/delete', async (req, res) => {
        try {
            const keyToDelete = req.body.apiKey;
            if (!keyToDelete) {
                req.session.message = { type: 'danger', text: 'API key is required' };
                return res.redirect('/admin');
            }

            try {
                const deletedKey = keyService.removeApiKey(keyToDelete);
                req.session.message = { type: 'success', text: `API key ${deletedKey.substring(0, 10)}... deleted successfully` };
            } catch (error) {
                req.session.message = { type: 'danger', text: error.message };
            }

            res.redirect('/admin');
        } catch (error) {
            console.error('Error deleting API key:', error);
            req.session.message = { type: 'danger', text: 'Failed to delete API key' };
            res.redirect('/admin');
        }
    });

    // 获取最新日志
    router.get('/logs', async (req, res) => {
        try {
            const logs = await readRecentLogs();
            res.json({ logs });
        } catch (error) {
            console.error('Error fetching logs:', error);
            res.status(500).json({ error: 'Failed to fetch logs' });
        }
    });

    return router;
};

// 辅助函数：读取最近的日志
async function readRecentLogs(limit = 100) {
    try {
        const logFile = path.join(__dirname, '../../logs/combined.log');
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
        console.error('Error reading logs:', error);
        return [];
    }
}

// 辅助函数：获取24小时内的总请求数
async function getTotalRequests(redisClient) {
    try {
        const logFile = path.join(__dirname, '../../logs/combined.log');
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
        console.error('Error counting requests:', error);
        return 0;
    }
}

// 辅助函数：获取24小时内的错误率
async function getErrorRate(redisClient) {
    try {
        const logFile = path.join(__dirname, '../../logs/combined.log');
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
        console.error('Error calculating error rate:', error);
        return 0;
    }
}
