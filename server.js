require('dotenv').config();
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 3000;

// Multer配置 - 临时存储上传的视频
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = path.join(__dirname, 'uploads');
    if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${uuidv4()}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 100 * 1024 * 1024 }, // 100MB
  fileFilter: (req, file, cb) => {
    const allowedTypes = ['.mp4', '.mov', '.avi', '.webm'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowedTypes.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error('不支持的文件格式，请上传 MP4/MOV/AVI/WebM 格式'));
    }
  }
});

// 中间件
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Gemini AI 初始化
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// ============ API 路由 ============

// 上传并分析视频
app.post('/api/analyze', upload.single('video'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: '请上传视频文件' });
    }

    const videoPath = req.file.path;
    const videoId = path.basename(videoPath, path.extname(videoPath));

    // 发送SSE进度更新
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive'
    });

    const sendProgress = (step, message, data = null) => {
      res.write(`data: ${JSON.stringify({ step, message, data })}\n\n`);
    };

    sendProgress(1, '📁 视频上传成功，准备分析...');

    // Step 1: 读取视频文件并转为base64
    sendProgress(2, '🎬 正在将视频发送给 Gemini AI 分析...');
    const videoBuffer = fs.readFileSync(videoPath);
    const videoBase64 = videoBuffer.toString('base64');
    const mimeType = getMimeType(req.file.originalname);

    // Step 2: Gemini 逐帧分析
    sendProgress(3, '🔍 Gemini AI 正在逐帧分析视频...');

    const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });

    const analysisPrompt = `你是一个专业的TikTok带货短视频拆解分析师。请对这个视频进行逐帧拆解分析。

请按以下JSON格式输出分析结果（严格JSON格式，不要有多余文字）：

{
  "video_overview": {
    "total_duration_seconds": 视频总时长（秒），
    "total_shots": 总镜头数,
    "product_first_appear_seconds": 产品首次出现时间（秒）,
    "product_exposure_seconds": 产品露出总时长（秒）,
    "product_exposure_ratio": 产品露出占比（百分比数字）
  },
  "shots": [
    {
      "shot_number": 镜头编号,
      "time_start": "开始时间（秒）",
      "time_end": "结束时间（秒）",
      "shot_type": "镜头类型：痛点放大/产品展示/使用场景/细节特写/效果对比/行动引导/开箱展示/社交证明/情绪渲染",
      "scene_description": "画面描述（中文，详细描述画面内容）",
      "text_overlay": "画面上的文字/字幕（如果有的话，原文）",
      "voiceover": "口播内容（如果有的话，原文）",
      "product_visible": true/false
    }
  ],
  "script_structure": {
    "framework": "匹配的框架类型：经典痛点型/效果前置型/对比碾压型/多场景轰炸型/开箱种草型/好奇悬念型/社交证明型/科普权威型/真实体验型/剧情反转型",
    "formula": "底层公式，如：停→病→药→信→买",
    "hook_type": "开头钩子类型：痛点冲击/效果冲击/好奇悬念/社交证明/真实场景/知识科普/冲突反转/开箱惊喜/对比冲击",
    "structure_breakdown": [
      {
        "element": "停/病/药/信/买",
        "time_range": "对应时间段",
        "description": "这一段做了什么",
        "shots_included": [对应的镜头编号]
      }
    ]
  },
  "extracted_materials": {
    "hook_scripts": [
      {
        "text": "钩子话术原文",
        "type": "开头/中间/结尾",
        "action_type": "痛点共鸣/提问触发/结果前置/反常识/数字可信/场景代入/稀缺促单/损失厌恶/直接指令/权益利诱"
      }
    ],
    "pain_points": [
      {
        "scene": "痛点场景描述",
        "user_pain": "用户痛点",
        "emotion_keywords": ["情绪关键词"],
        "product_solution": "产品如何解决"
      }
    ],
    "selling_points": [
      {
        "description": "卖点描述",
        "visual_type": "画面类型：使用前后对比/极限测试/细节放大/真实反应镜头/场景演示/开箱展示",
        "shooting_notes": "拍摄说明"
      }
    ],
    "social_proof": [
      {
        "type": "用户好评/网红背书/权威认证/销量数据",
        "content": "具体内容"
      }
    ],
    "cta_scripts": [
      {
        "text": "促单话术原文",
        "type": "结尾促单",
        "incentive": "使用的权益/优惠"
      }
    ],
    "bgm": {
      "mood": "紧张推进型/爽感共鸣型/轻松治愈型/流行趋势音",
      "description": "BGM的节奏和风格描述"
    }
  },
  "reusable_points": "可复用的亮点总结（1-3条，每条一句话）",
  "optimization_suggestions": "优化建议（1-2条）"
}

请仔细分析每一帧画面，确保：
1. 镜头切割准确，每个场景变化都要识别
2. 画面上的文字和口播内容要完整提取
3. 脚本结构要准确匹配到"停病药信买"框架
4. 提取的素材要详细，可以直接用于填充素材库`;

    const result = await model.generateContent([
      { text: analysisPrompt },
      {
        inlineData: {
          mimeType: mimeType,
          data: videoBase64
        }
      }
    ]);

    const responseText = result.response.text();
    sendProgress(4, '📊 AI 分析完成，正在解析结果...');

    // 解析JSON结果
    let analysisResult;
    try {
      // 尝试提取JSON
      const jsonMatch = responseText.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        analysisResult = JSON.parse(jsonMatch[0]);
      } else {
        throw new Error('无法从AI响应中提取JSON');
      }
    } catch (parseError) {
      console.error('JSON解析失败:', parseError);
      analysisResult = { raw_response: responseText, parse_error: true };
    }

    sendProgress(5, '✅ 拆解完成！', {
      videoId,
      videoUrl: `/uploads/${req.file.filename}`,
      analysis: analysisResult
    });

    // 清理：延迟删除临时视频文件（保留1小时）
    setTimeout(() => {
      if (fs.existsSync(videoPath)) {
        fs.unlinkSync(videoPath);
      }
    }, 3600000);

    res.end();

  } catch (error) {
    console.error('分析失败:', error);
    if (!res.headersSent) {
      res.status(500).json({ error: '分析失败: ' + error.message });
    } else {
      res.write(`data: ${JSON.stringify({ step: -1, message: '❌ 分析失败: ' + error.message })}\n\n`);
      res.end();
    }
  }
});

// 获取分析历史
app.get('/api/history', (req, res) => {
  // TODO: 从飞书多维表格读取历史记录
  res.json({ records: [] });
});

// 健康检查
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// 工具函数
function getMimeType(filename) {
  const ext = path.extname(filename).toLowerCase();
  const types = {
    '.mp4': 'video/mp4',
    '.mov': 'video/quicktime',
    '.avi': 'video/x-msvideo',
    '.webm': 'video/webm'
  };
  return types[ext] || 'video/mp4';
}

// 启动服务
app.listen(PORT, () => {
  console.log(`🚀 爆款短视频拆解工具已启动: http://localhost:${PORT}`);
});
