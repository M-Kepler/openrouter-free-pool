require('dotenv').config();
const express = require('express');
const Redis = require('redis');
const logger = require('./logger');
const path = require('path');
const session = require('express-session');
const cors = require('cors');
const bodyParser = require('body-parser');
const KeyService = require('./services/keyService');
const RedisService = require('./services/redisService');
const ApiService = require('./services/apiService');
const apiRouter = require('./routes/api');
const adminRouter = require('./routes/admin');
const { errorHandler } = require('./middlewares/errorHandler');

const app = express();

// 初始化Redis连接
const redisClient = Redis.createClient({
    url: `redis://${process.env.REDIS_HOST}:${process.env.REDIS_PORT}`
});

(async () => {
    try {
        await redisClient.connect();
        logger.info('Successfully connected to Redis');
    } catch (error) {
        logger.error('Failed to connect to Redis:', error);
        process.exit(1);
    }
})();

// 初始化服务
const API_KEYS = process.env.OPENROUTER_API_KEYS.split(',');
const redisService = new RedisService(redisClient);
const keyService = new KeyService(redisClient, API_KEYS);
const apiService = new ApiService(keyService, redisService);

// 中间件配置
app.use(bodyParser.json({ limit: '10mb' }));
app.use(bodyParser.urlencoded({ limit: '10mb', extended: true }));
app.use(session({
    secret: process.env.SESSION_SECRET || 'your-secret-key',
    resave: false,
    saveUninitialized: true
}));
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '../views'));
app.use(express.static(path.join(__dirname, '../public')));

// CORS配置
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));

// 请求日志中间件
app.use((req, res, next) => {
    const start = Date.now();
    res.on('finish', () => {
        const duration = Date.now() - start;
        logger.debug(JSON.stringify({
            method: req.method,
            path: req.path,
            status: res.statusCode,
            duration: `${duration}ms`,
            ip: req.ip
        }, undefined, 4));
    });
    next();
});

// 路由配置
app.use('/api/v1', apiRouter(apiService));
app.use('/admin', adminRouter(keyService));

// 错误处理中间件（必须放在最后）
app.use(errorHandler);

// 启动服务器
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    logger.info(`Server is running on port ${PORT}`);
});
