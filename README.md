# 抖音无水印下载（Web 版）

把抖音分享口令变成无水印直链：粘贴 → 解析 → 预览 → 下载。
零依赖（纯 `fetch`），跑在 Vercel 上，解析与下载都是 Serverless Function。

> ⚠️ 仅供个人学习使用，请勿用于商业用途，版权归原作者所有。

## 功能

- 支持整段分享口令自动抠链接（`7.43 复制打开抖音，看看【xxx】 https://v.douyin.com/xxxxx/`）
- 1080p 无水印 mp4（拿不到自动降级 720p）
- 图集（aweme_type=2）：视频为空，返回全部原图
- 背景音乐单独下载
- 前端移动端优先、暗色单列布局，带文件大小与下载进度
- `/api/proxy` 支持 Range / 206 / Content-Range，可直接喂播放器

## 目录

```
web/
├── api/
│   ├── parse.js      # POST 解析（Node Runtime）
│   └── proxy.js      # GET 字节流转发（Node Runtime 流式响应，maxDuration 60s）
├── lib/
│   └── douyin.js     # 核心解析，零依赖
├── public/
│   └── index.html    # 单文件前端（内联 CSS/JS）
├── package.json
├── vercel.json
└── .gitignore
```

## 接口

### POST /api/parse

```bash
curl -X POST https://<你的域名>/api/parse \
  -H 'Content-Type: application/json' \
  -d '{"text":"https://v.douyin.com/ei0NQP1StKA/"}'
```

成功：

```json
{
  "ok": true,
  "data": {
    "platform": "douyin",
    "title": "…",
    "author": "…",
    "cover": "https://…",
    "videos": ["https://aweme.snssdk.com/aweme/v1/play/?line=0&ratio=1080p&video_id=…"],
    "images": [],
    "music": [],
    "extra": { "aweme_id": "…", "aweme_type": 4, "ratio": "1080p", "size_bytes": 1353814 }
  }
}
```

失败（400）：

```json
{ "ok": false, "error": "没拿到作品数据（分享页未返回 SSR 数据）" }
```

### GET /api/proxy?url=&lt;直链&gt;

带 `Referer: https://www.douyin.com/` 与移动端 UA 转发字节流，透传
`Content-Type` / `Content-Length` / `Content-Range` / `Accept-Ranges`，支持 `Range` 与 `206`。

```bash
curl -r 0-1023 "https://<你的域名>/api/proxy?url=<encodeURIComponent(直链)>" -o part.bin
```

## 部署

### 1. 连接 GitHub 仓库

```bash
git init
git add -A
git commit -m "feat: douyin nowm web"
git branch -M main
git remote add origin https://github.com/<你的用户名>/douyin-nowm.git
git push -u origin main
```

### 2. 在 Vercel 导入

1. 打开 https://vercel.com/new
2. 选择 **Import Git Repository** → 授权 GitHub → 选中 `douyin-nowm`
3. Framework Preset 选 **Other**（不用改 Build Command / Output Directory）
4. **不需要配置任何环境变量、不需要任何密钥**
5. 点 **Deploy**，约 30 秒完成，拿到 `https://douyin-nowm-xxx.vercel.app`

之后每次 `git push` 到 `main` 会自动重新部署。

### 3. 本地调试（可选）

```bash
npm i -g vercel
vercel dev        # 默认 http://localhost:3000
```

## 实现要点

1. **Cookie 复用是硬要求**：分享页只在带 `ttwid` 会话时才吐 `_ROUTER_DATA`。
   流程是「短链 302 取 set-cookie → 带 Cookie 请求分享页」，如果这一跳没给 `ttwid`，
   会向 `ttwid.bytedance.com` 注册接口申请一个再重试。
2. **1080p 优先**：由 `play_addr.uri` 重建
   `https://aweme.snssdk.com/aweme/v1/play/?line=0&ratio=1080p&video_id={uri}`，
   把 `playwm` 换成 `play` 即无水印；用 `Range: bytes=0-0` 探测，不通则降级 720p。
3. **图集分支**：`aweme_type=2` 时 `videos` 强制为空，`images` 取每张图 `url_list` 的最后一项。
4. **proxy 走流式响应**：Vercel 2026 已弃用 Edge Runtime（匿名部署直接报错），
   因此改用 Node Runtime + `Readable.fromWeb().pipe(res)` 边下边发，并把 `maxDuration` 提到 60s，
   避免默认 10s 超时截断视频。Range / 206 / Content-Range 语义不变。

## 已知限制

- **未登录分享页的 `bit_rate` 为空**，最高只到 1080p —— 这就是当前原画上限，
  想要 2K/4K 需要登录态 Cookie。
- **仅支持抖音**，不支持快手/小红书/B站等（那套解析在 `server/` 的 Python 版里）。
- **Vercel 在国内需代理访问**，`*.vercel.app` 域名直连大概率超时。

## 免责声明

本项目仅用于技术学习与研究，请勿用于任何商业用途或侵犯他人权益的场景。
下载内容版权归原作者所有，请在获得授权的前提下使用。
