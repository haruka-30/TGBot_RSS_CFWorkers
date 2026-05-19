# TGBot RSS - Cloudflare Workers 一键部署版

```
    _    _     ____            _ 
   / \  | |__ | __ ) _   _  __(_)
  / _ \ | '_ \|  _ \| | | |/ _| |
 / ___ \| |_) | |_) | |_| | (_| |
/_/   \_\_.__/|____/ \__,_|\__,_|
```

基于 Cloudflare Workers 的 Telegram RSS 订阅机器人，支持关键词过滤、多用户订阅、邮件推送。

## 注：rss订阅如果大于9个建议前往源项目使用服务器/容器部署，cloudflare kv空间每天有**1000次**写入次数限制，抓取频率过低无法及时接收消息

-源项目地址：*https://github.com/IonRh/TGBot_RSS*

## ✨ 新增功能

- 📧 **邮件推送**：管理员可在 Telegram 菜单中配置邮件服务，RSS 更新同时推送到邮箱
- ☁️ **Cloudflare Workers 部署**：免费额度即可运行，无需服务器
- 🔧 **环境变量配置**：在 Cloudflare Dashboard 绑定变量即可使用

## 🚀 部署方式（按推荐顺序）

> ⚠️ Cloudflare Workers 仪表板不支持直接上传 ZIP 文件（那是 Pages 的功能）。但 Workers 提供了同样便利的 "Deploy to Cloudflare 按钮" 和 "粘贴单文件" 部署方式。



### 方式一：仪表板粘贴单文件（最简单，无需 CLI）

1. **创建 Worker**：
   - 登录 [Cloudflare Dashboard](https://dash.cloudflare.com)
   - 进入 **Workers & Pages** → **Create** → **Create Worker**
   - 起个名字（如 `tgbot-rss`），点击 **部署**
   - 部署后点击 ****

2. **替换代码**：
   - 删除编辑器中的默认代码
   - 打开本仓库的 [`_worker.js`](./_worker.js) 文件，复制全部内容
   - 粘贴到编辑器中
   - 点击 **Deploy** 保存

3. **绑定环境变量**（在 Worker 的 **设置** 页面）：

   **变量和机密** → **添加变量**：
   - `BOT_TOKEN`（类型 文本/密钥）= 你的 Telegram Bot Token
   - `ADMIN_ID`（类型 文本）= 你的 Telegram User ID（设为 `0` 表示所有人可用）

   **绑定** → **添加绑定** → **KV 命名空间**：
   - 先到 **Workers & Pages** → **KV** → **Create namespace** 创建（如 `tgbot-rss-kv`）
   - 回到 Worker，变量名填 `KV`，选择刚创建的命名空间

4.**设置触发器** （也在worker的 **设置**界面）

   **触发事件** → **添加** → **Cron 触发器** → **计划**
   - 填写你想要的执行频率即可

5。 **注册 Webhook**：
   - 点击注册webhook
   - 看到 `✅ Webhook 注册成功`即可开始使用

6。 **开始使用**：在 Telegram 中给 Bot 发送 `/start`

### 方式二：Wrangler CLI（适合开发者）

```bash
# 1. 安装 Wrangler
npm install -g wrangler
wrangler login

# 2. 进入 workers 目录
cd workers

# 3. 创建 KV 命名空间，将输出的 id 填入 wrangler.toml
wrangler kv:namespace create "KV"

# 4. 设置 Secrets
wrangler secret put BOT_TOKEN
wrangler secret put ADMIN_ID

# 5. 部署
wrangler deploy

# 6. 浏览器访问 https://你的worker域名/setup 注册 Webhook
```

## 📋 配置说明

| 配置项 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| `BOT_TOKEN` | Secret | ✅ | Telegram Bot API Token |
| `ADMIN_ID` | Variable | ✅ | 管理员 User ID，设 `0` 表示所有人可用 |
| `KV` | KV Binding | ✅ | KV 命名空间，存储订阅数据 |
| Cron Trigger | - | ✅ | 推荐 `* * * * *` 每分钟 |

## 📧 邮件推送配置

在 Telegram 聊天中通过菜单配置：

1. 发送 `/start` → 点击 **📧 邮件推送**
2. 点击 **⚙️ 配置邮件服务** 设置：
   - **模式**：`mailchannels` / `resend` / `sendgrid` / `custom`
   - **发件人邮箱**
   - **API Key**（Resend / SendGrid 需要）
3. 点击 **👥 收件人管理** 添加收件邮箱
4. 点击 **🧪 发送测试邮件** 验证
5. 点击 **✅ 启用推送** 开启

### 邮件服务对比

| 服务 | 免费额度 | 配置难度 | 推荐度 |
|------|---------|---------|--------|
| **Resend** | 100封/天 | 简单（API Key） | ⭐⭐⭐⭐⭐ |
| **MailChannels** | 免费 | 中（需域名 DNS） | ⭐⭐⭐⭐ |
| **SendGrid** | 100封/天 | 简单（API Key） | ⭐⭐⭐ |
| **自定义API** | - | 自定义 | ⭐⭐ |

#### Resend 配置示例（推荐）

1. 注册 [Resend](https://resend.com)
2. 添加并验证发件域名
3. 创建 API Key
4. 在 Bot 中：
   - 模式：`resend`
   - 发件人：`noreply@yourdomain.com`
   - API Key：粘贴刚创建的 Key
5. 添加收件人 → 测试 → 启用

#### MailChannels 配置（免费但需要域名）

需要在域名 DNS 添加 SPF 记录：
```
TXT  _mailchannels  v=mc1 cfid=你的worker子域.workers.dev
TXT  @              v=spf1 include:relay.mailchannels.net ~all
```

## 🔧 使用指南

### Telegram 命令

- `/start` - 显示主菜单
- `/help` - 显示帮助

### 关键词语法

- 普通关键词：`科技`
- 通配符：`科技*新闻`
- 屏蔽词：`-广告`
- 标题匹配：`#t技术`
- 描述匹配：`#c新闻`
- 全文匹配：`#a科技`
- 指定RSS源：`技术+科技新闻`
- 全量推送：`*`

### 添加订阅

格式：`URL 名称 频道模式`
- `0`：标准模式（标题+链接）
- `1`：频道模式（完整内容+图片）

例：`https://example.com/feed 科技新闻 0`

## 📊 架构

```
┌─────────────────────────────────────────┐
│        Cloudflare Workers (单文件)       │
├─────────────────────────────────────────┤
│  Webhook  ←─── Telegram                 │
│  Cron     ───→ RSS Fetcher              │
│  Email    ───→ MailChannels/Resend/...  │
├─────────────────────────────────────────┤
│           Cloudflare KV                 │
│   (订阅/关键词/Feed/邮件配置)            │
└─────────────────────────────────────────┘
```

## ⚠️ 免费额度限制

- 请求：100,000 次/天
- CPU：10ms/次
- KV 读：100,000 次/天
- KV 写：1,000 次/天

订阅多时建议把 Cron 改为 `*/5 * * * *` 减少请求。

## 📁 项目文件

- [`_worker.js`](./_worker.js) - 单文件 Worker（用于粘贴部署）
- [`wrangler.toml`](./wrangler.toml) - Wrangler CLI 部署配置
- [`src/`](./src/) - 模块化源码（用于二次开发）

## 📄 License

MIT

## ai编码，纯图一乐，有问题请自行解决，笔者也不懂 W(￣_￣)W
