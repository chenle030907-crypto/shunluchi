# 上线清单

Render 一键部署入口：

```text
https://render.com/deploy?repo=https://github.com/chenle030907-crypto/shunluchi
```

## 第 1 阶段：可公开访问

- 部署当前 Node Web App 到长期托管平台
- 配置 `AMAP_KEY`
- 配置 HTTPS 域名
- 使用 `/healthz` 做健康检查
- 确认 `/api/status` 显示 `provider: "amap"`
- 如果要启用 AI 识别，确认 `/api/status` 显示 `aiProvider: "openai"`
- 确认 `/api/library` 可以返回资料库 JSON
- 确认“复制同步链接”可以在另一台设备打开同一份资料库
- 确认 `/app` 可以打开应用
- 确认浏览器可以读取 `/manifest.webmanifest`
- 手机浏览器测试“添加到主屏幕”

### Render 部署

1. 把项目上传到 GitHub 仓库
2. 在 Render 新建 Web Service
3. 选择这个仓库
4. Render 会读取 `render.yaml`
5. 配置环境变量：
   - `AMAP_KEY`
   - `OPENAI_API_KEY`（可选）
   - `OPENAI_MODEL`（可选，默认 `gpt-4o-mini`）
6. 部署完成后访问：
   - `https://你的服务名.onrender.com/app`

### Railway 部署

1. 把项目上传到 GitHub 仓库
2. 在 Railway 新建 Project
3. 选择 Deploy from GitHub Repo
4. Railway 会读取 `railway.json` 和 `Dockerfile`
5. 配置环境变量：
   - `AMAP_KEY`
   - `OPENAI_API_KEY`（可选）
   - `OPENAI_MODEL`（可选，默认 `gpt-4o-mini`）
6. 部署完成后绑定域名或使用 Railway 提供的公网域名

### 自己的服务器/VPS

```bash
git clone 你的仓库地址
cd new-chat
npm install
AMAP_KEY=你的高德Key npm start
```

生产环境建议用进程管理器保持常驻，例如 `pm2`、systemd 或 Docker。

### 域名

长期使用建议绑定域名：

- 购买域名
- 在托管平台添加 Custom Domain
- 按平台提示配置 DNS 记录
- 等待 HTTPS 证书自动签发

## 第 2 阶段：可保存用户数据

- 当前版本已内置轻量服务端资料库同步，适合内测和个人使用
- Render 免费服务的文件存储不适合作为正式长期数据库
- 增加登录
- 增加数据库表：
  - users
  - sources
  - entities
  - trips
  - recommendations
- 将当前 `localStorage` 资料库迁移到后端 API

## 第 3 阶段：真实识别媒体

- 当前版本已支持浏览器端截图 OCR
- 当前版本已支持高德 POI 校验式识别文案和截图 OCR
- 图片上传到对象存储
- 视频关键帧抽取
- 音频转文字
- 大模型合并标题、文案、OCR、ASR 结果

## 第 4 阶段：正式商业化

- 邀请内测用户
- 加埋点和错误监控
- 增加分享页
- 增加隐私政策和用户协议
- 明确小红书/抖音内容授权策略
