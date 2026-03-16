# 🎬 TikTok 爆款短视频拆解工具

AI驱动的视频结构分析与素材入库系统。

## 功能

- **视频上传** → 拖拽或选择视频文件上传
- **Gemini AI 逐帧分析** → 自动识别镜头切换、场景分类、产品出现
- **脚本结构分析** → 匹配"停病药信买"框架，识别底层公式
- **素材自动提取** → 钩子话术、痛点场景、卖点画面、社会证明
- **飞书入库**（Phase 2）→ 拆解结果自动写入飞书多维表格

## 部署到 Zeabur

### 方式一：通过 GitHub

1. 把这个项目推送到你的 GitHub 仓库
2. 在 Zeabur 控制台 → 你的项目 → 点击 "+" 添加服务
3. 选择 "Deploy from GitHub" → 选择这个仓库
4. 在环境变量中配置：
   - `GEMINI_API_KEY` = 你的 Google Gemini API Key
   - `PORT` = 3000

### 方式二：通过 Zeabur CLI

```bash
npm install -g @zeabur/cli
zeabur login
zeabur deploy
```

### 环境变量

| 变量名 | 说明 | 必填 |
|--------|------|------|
| GEMINI_API_KEY | Google Gemini API Key | ✅ |
| PORT | 服务端口（默认3000） | ❌ |
| FEISHU_APP_ID | 飞书应用ID（Phase 2） | ❌ |
| FEISHU_APP_SECRET | 飞书应用密钥（Phase 2） | ❌ |

## 本地开发

```bash
# 安装依赖
npm install

# 复制环境变量
cp .env.example .env
# 编辑 .env 填入你的 API Key

# 启动
npm start
```

打开 http://localhost:3000 即可使用。

## 技术栈

- **后端**: Node.js + Express
- **AI**: Google Gemini 2.0 Flash（视频分析）
- **前端**: 原生 HTML/CSS/JS
- **部署**: Zeabur
- **存储**: Google Drive（Phase 2）
- **数据库**: 飞书多维表格（Phase 2）
