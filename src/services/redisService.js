const logger = require('../logger');

class RedisService {
    constructor(client) {
        this.client = client;
    }

    // 原子操作增加计数并检查限制
    async incrementWithLimit(counterKey, limit, ttl) {
        try {
            const count = await this.client.incr(counterKey);

            if (count > limit) {
                // 如果超出限制，回滚计数
                await this.client.decr(counterKey);
                logger.warn(`Limit exceeded for ${counterKey}, rolling back`);
                throw new Error(`Limit exceeded for ${counterKey}`);
            }

            // 设置过期时间
            if (await this.client.ttl(counterKey) < 0) {
                await this.client.expire(counterKey, ttl);
            }

            return count;
        } catch (error) {
            logger.error(`Error incrementing counter ${counterKey}:`, error);
            throw error;
        }
    }

    // 获取多个计数器状态
    async getCounters(keyPrefix, counterNames) {
        try {
            const keys = counterNames.map(name => `${keyPrefix}:${name}`);
            const values = await this.client.mget(keys);

            const result = {};
            counterNames.forEach((name, index) => {
                result[name] = values[index] ? parseInt(values[index]) : 0;
            });

            return result;
        } catch (error) {
            logger.error(`Error getting counters for ${keyPrefix}:`, error);
            throw error;
        }
    }

    // 设置计数器值和过期时间
    async setCounterWithTTL(counterKey, value, ttl) {
        try {
            await this.client.setEx(counterKey, ttl, value.toString());
            return value;
        } catch (error) {
            logger.error(`Error setting counter ${counterKey}:`, error);
            throw error;
        }
    }

    // 获取计数器TTL
    async getCounterTTL(counterKey) {
        try {
            return await this.client.ttl(counterKey);
        } catch (error) {
            logger.error(`Error getting TTL for ${counterKey}:`, error);
            throw error;
        }
    }

    // 删除计数器
    async deleteCounter(counterKey) {
        try {
            await this.client.del(counterKey);
            return true;
        } catch (error) {
            logger.error(`Error deleting counter ${counterKey}:`, error);
            throw error;
        }
    }

    // 批量获取计数器状态
    async getMultipleCounters(counterKeys) {
        try {
            const values = await this.client.mget(counterKeys);
            return values.map(value => value ? parseInt(value) : 0);
        } catch (error) {
            logger.error('Error getting multiple counters:', error);
            throw error;
        }
    }

    // 检查键是否存在
    async keyExists(key) {
        try {
            const result = await this.client.exists(key);
            return result === 1;
        } catch (error) {
            logger.error(`Error checking key existence for ${key}:`, error);
            throw error;
        }
    }

    // 获取所有键的TTL
    async getAllKeysTTL(pattern) {
        try {
            const keys = await this.client.keys(pattern);
            if (keys.length === 0) return {};

            const ttlValues = await this.client.mget(keys.map(key => `${key}:ttl`));
            const result = {};

            keys.forEach((key, index) => {
                result[key] = ttlValues[index] ? parseInt(ttlValues[index]) : null;
            });

            return result;
        } catch (error) {
            logger.error(`Error getting TTL for keys with pattern ${pattern}:`, error);
            throw error;
        }
    }
}

module.exports = RedisService;
