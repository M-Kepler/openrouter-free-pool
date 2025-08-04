const logger = require('../logger');

class KeyService {
    constructor(redisClient, apiKeys) {
        this.redis = redisClient;
        this.apiKeys = apiKeys;
    }

    // 获取可用的API密钥
    async getAvailableApiKey() {
        for (const key of this.apiKeys) {
            const minuteCount = await this.redis.get(`${key}:minute`);
            const dayCount = await this.redis.get(`${key}:day`);

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
    async updateApiKeyUsage(key) {
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
            const minuteCount = await this.redis.incr(minuteKey);
            const dayCount = await this.redis.incr(dayKey);

            // 检查是否超出限制
            if (minuteCount > 20 || dayCount > 200) {
                // 如果超出限制，回滚计数
                if (minuteCount > 20) {
                    await this.redis.decr(minuteKey);
                    logger.warn(`Minute limit exceeded for key ${key.substring(0, 10)}..., rolling back`);
                }
                if (dayCount > 200) {
                    await this.redis.decr(dayKey);
                    logger.warn(`Daily limit exceeded for key ${key.substring(0, 10)}..., rolling back`);
                }
                throw new Error('Rate limit exceeded');
            }

            // 设置过期时间
            if (await this.redis.ttl(minuteKey) < 0) {
                await this.redis.expire(minuteKey, 60);
            }
            if (await this.redis.ttl(dayKey) < 0) {
                await this.redis.expire(dayKey, secondsUntilTomorrow);
            }

            logger.debug(`Updated usage for key ${key.substring(0, 10)}... (minute: ${minuteCount}/20, day: ${dayCount}/200, expires at ${tomorrow.toISOString()})`);
        } catch (error) {
            logger.error('Error updating API key usage:', error);
            throw error;
        }
    }

    // 获取所有API密钥状态
    async getKeysStatus() {
        try {
            const results = [];
            for (const key of this.apiKeys) {
                const minuteCount = await this.redis.get(`${key}:minute`);
                const dayCount = await this.redis.get(`${key}:day`);

                // 获取剩余时间
                const minuteTTL = await this.redis.ttl(`${key}:minute`);
                const dayTTL = await this.redis.ttl(`${key}:day`);

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

            return {
                total_keys: this.apiKeys.length,
                available_keys: totalAvailable,
                keys: results
            };
        } catch (error) {
            logger.error('Error fetching keys status:', error);
            throw error;
        }
    }

    // 添加API密钥
    addApiKey(newKey) {
        if (!newKey) {
            throw new Error('API key is required');
        }

        // 验证密钥格式
        if (!newKey.startsWith('sk-')) {
            throw new Error('Invalid API key format');
        }

        // 检查密钥是否已存在
        if (this.apiKeys.includes(newKey)) {
            throw new Error('API key already exists');
        }

        this.apiKeys.push(newKey);
        return newKey;
    }

    // 删除API密钥
    removeApiKey(keyToDelete) {
        if (!keyToDelete) {
            throw new Error('API key is required');
        }

        // 从数组中移除密钥
        const index = this.apiKeys.findIndex(k => k.startsWith(keyToDelete.split('...')[0]));
        if (index === -1) {
            throw new Error('API key not found');
        }

        const fullKey = this.apiKeys[index];
        this.apiKeys.splice(index, 1);

        // 清除Redis中的相关数据
        this.redis.del(`${fullKey}:minute`);
        this.redis.del(`${fullKey}:day`);

        return fullKey;
    }
}

module.exports = KeyService;
