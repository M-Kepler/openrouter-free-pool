const logger = require('../logger');

class AppError extends Error {
    constructor(message, statusCode, details) {
        super(message);
        this.statusCode = statusCode;
        this.details = details;
        this.isOperational = true;
        Error.captureStackTrace(this, this.constructor);
    }
}

const errorHandler = (err, req, res, next) => {
    let error = { ...err };
    error.message = err.message;

    // 记录错误日志
    logger.error('Error occurred:', {
        message: error.message,
        stack: err.stack,
        url: req.originalUrl,
        method: req.method,
        ip: req.ip,
        userAgent: req.get('User-Agent')
    });

    // Mongoose错误处理
    if (err.name === 'CastError') {
        const message = 'Resource not found';
        error = new AppError(message, 404);
    }

    // Mongoose重复字段错误
    if (err.code === 11000) {
        const message = 'Duplicate field value entered';
        error = new AppError(message, 400);
    }

    // Mongoose验证错误
    if (err.name === 'ValidationError') {
        const message = Object.values(err.errors).map(val => val.message);
        error = new AppError(message, 400);
    }

    // JWT错误
    if (err.name === 'JsonWebTokenError') {
        const message = 'Invalid token. Please log in again.';
        error = new AppError(message, 401);
    }

    // JWT过期错误
    if (err.name === 'TokenExpiredError') {
        const message = 'Your token has expired. Please log in again.';
        error = new AppError(message, 401);
    }

    // Redis连接错误
    if (err.message.includes('Redis')) {
        const message = 'Service temporarily unavailable. Please try again later.';
        error = new AppError(message, 503);
    }

    // Axios错误
    if (err.response) {
        error.statusCode = err.response.status;
        error.message = err.response.data?.error?.message || err.message;
    }

    // 发送错误响应
    res.status(error.statusCode || 500).json({
        success: false,
        error: {
            message: error.message || 'Internal Server Error',
            code: error.statusCode || 500,
            ...(process.env.NODE_ENV === 'development' && {
                stack: err.stack,
                details: error.details
            })
        }
    });
};

module.exports = {
    AppError,
    errorHandler
};
