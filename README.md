# 顺路吃

从探店文案、截图或视频灵感中提取景点、美食和店名，生成顺路吃喝路线的 Web App。

## 本地运行

```bash
npm start
```

打开：

```text
http://127.0.0.1:4173
```

同一 Wi-Fi 下的其他设备访问：

```text
http://你的电脑局域网IP:4173/app
```

应用顶部会自动显示可复制的局域网地址。手机和电脑必须在同一个 Wi-Fi 下；如果 macOS 弹出防火墙提示，需要允许 Node 接受传入连接。

可选环境变量：

```bash
AMAP_KEY=你的高德Web服务Key npm start
```

也可以复制 `.env.example` 为 `.env`，把 `AMAP_KEY` 写进去后直接运行 `npm start`。

没有 `AMAP_KEY` 时，应用会自动使用本地规则和模拟 POI，不影响产品流程演示。

## 上线部署

这是一个无依赖 Node Web App，任何支持 Node 20+ 的平台都可以部署。

部署配置：

- Start command: `npm start`
- Health check: `/healthz`
- Port: 使用平台注入的 `PORT`
- Env:
  - `AMAP_KEY`：高德 Web 服务 Key
  - `OPENAI_API_KEY`：可选，用于调用 OpenAI 进行更稳的文案/图片识别
  - `OPENAI_MODEL`：可选，默认 `gpt-4o-mini`
  - `HOST`：默认 `0.0.0.0`
  - `DATA_DIR`：可选，服务端资料库文件保存目录

Docker 部署：

```bash
docker build -t shunluchi .
docker run -p 4173:4173 -e AMAP_KEY=你的高德Key shunluchi
```

长期稳定访问：

- 部署到 Render、Railway、Fly.io、VPS 等长期托管平台
- 绑定自己的域名，例如 `https://shunluchi.com`
- 如果需要 24 小时稳定在线，选择不会休眠的实例或服务器
- 当前已支持轻量云端资料库同步；正式长期保存用户数据时，建议继续接 PostgreSQL、Supabase 或其他数据库
- 资料库按同步空间码隔离，点击“复制同步链接”可以在其他设备打开同一份资料库

## 当前能力

- PWA，可部署后添加到手机桌面
- 文案/截图导入
- 截图上传和浏览器端 OCR
- 高德 POI 校验式识别，可从文案和 OCR 中补全景点/店名地址
- 识别结果预览
- 手动修正后确认入库
- 无效内容不入库
- 本地资料库和地点详情库
- 高德 POI 代理接口
- 云端资料库同步 API
- 同步链接，可跨设备打开同一份资料库
- 资料库 JSON 文件导入/导出，方便迁移和备份
- 景点附近美食推荐
- 路线预览

## 可访问路径

部署后可以访问：

```text
/
/app
```

`/app` 更适合放在宣传页或二维码里，用户点进去就是应用本体。

## 正式上线前还需要

- 用户账号和云端资料库
- 正式数据库和备份
- AI 识别结果质量评测和纠错
- 视频关键帧抽取
- 语音转文字
- 高德 POI 详情和路线规划
- 文件上传和对象存储
- 隐私政策、用户协议和数据删除能力
