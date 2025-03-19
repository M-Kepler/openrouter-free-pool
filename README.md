# OpenRouter Free Pool

这是一个OpenRouter API连接池服务，用于管理和负载均衡多个免费API密钥的使用。

## 功能特点

- 支持多个OpenRouter免费API密钥的负载均衡
- 自动处理API调用限制（每分钟20次，每天200次）
- 使用Redis存储API调用状态
- 自动故障转移：当某个API密钥达到限制时自动切换到其他可用密钥
- Web管理界面：
  - 实时监控API密钥状态和使用情况
  - 添加/删除API密钥
  - 查看24小时请求统计和错误率
  - 实时错误日志查看
  - 自动刷新状态和日志

## 系统要求

### 直接部署
- Node.js 14+
- Redis 6+

### Docker部署
- Docker 20.10+
- Docker Compose 2.0+

## 安装和部署

### 方式一：直接部署

1. 克隆仓库：
```bash
git clone [repository-url]
cd openrouter-free-pool
```

2. 安装依赖：
```bash
npm install
```

3. 配置环境变量：
复制`.env.example`文件到`.env`并填写必要的配置：
```bash
cp .env.example .env
```

编辑`.env`文件，设置以下配置：
- `REDIS_HOST`: Redis服务器地址
- `REDIS_PORT`: Redis服务器端口
- `OPENROUTER_API_KEYS`: OpenRouter API密钥列表（用逗号分隔）
- `PORT`: 服务运行端口
- `SESSION_SECRET`: Session密钥（可选，用于管理界面）

4. 运行服务：
```bash
npm start
```

### 方式二：Docker部署

1. 克隆仓库并进入目录：
```bash
git clone [repository-url]
cd openrouter-free-pool
```

2. 配置环境变量：
```bash
cp .env.example .env
```
编辑 `.env` 文件，设置必要的配置项。

3. 构建和启动容器：
```bash
docker-compose up -d
```

4. 查看日志：
```bash
docker-compose logs -f app
```

5. 停止服务：
```bash
docker-compose down
```

### Docker部署注意事项

1. 数据持久化：
   - Redis数据存储在命名卷 `redis_data` 中
   - 日志文件映射到主机的 `./logs` 目录
   - 环境配置文件 `.env` 映射到容器内

2. 端口映射：
   - 应用服务端口：3000
   - Redis端口：6379

3. 自动重启：
   - 服务配置了自动重启策略，除非手动停止
   - Redis配置了AOF持久化，确保数据不丢失

4. 环境变量：
   - Redis主机名在容器环境中自动设置为 `redis`
   - 可以通过修改 `docker-compose.yml` 自定义其他环境变量

## API使用

### OpenRouter API代理

服务提供与OpenRouter API相同的接口：

```bash
POST /api/v1/chat/completions
```

请求格式与OpenRouter API完全相同，无需提供API密钥。服务会自动选择可用的API密钥进行请求转发。

### 管理界面

访问管理界面：
```
http://your-server:3000/admin
```

管理界面功能：
- 查看所有API密钥的实时状态
  - 分钟和天级别的使用情况
  - 剩余配额
  - 重置时间倒计时
- 添加新的API密钥
- 删除现有API密钥
- 查看系统统计信息
  - 总密钥数量
  - 可用密钥数量
  - 24小时请求总量
  - 24小时错误率
- 实时错误日志查看
  - 自动每10秒更新
  - 支持手动刷新

### 健康检查

```bash
GET /health
```

返回服务状态信息。

## 错误处理

- 当所有API密钥都达到限制时，服务会返回429状态码，并提供详细的错误信息
- 使用Redis动态追踪API密钥的使用情况和限制状态
- 根据OpenRouter返回的重置时间自动管理密钥可用性

## 许可证

ISC 