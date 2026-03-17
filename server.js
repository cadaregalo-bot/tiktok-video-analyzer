require('dotenv').config();
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { v4: uuidv4 } = require('uuid');
const { execSync } = require('child_process');

const app = express();
const PORT = process.env.PORT || 3000;

// ============ Multer 配置 ============
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
  limits: { fileSize: 200 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowedTypes = ['.mp4', '.mov', '.avi', '.webm'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowedTypes.includes(ext)) cb(null, true);
    else cb(new Error('不支持的文件格式，请上传 MP4/MOV/AVI/WebM'));
  }
});

// ============ 中间件 ============
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.use('/frames', express.static(path.join(__dirname, 'frames')));

// ============ Gemini AI ============
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// ============ 飞书配置（Phase 2 预留） ============
const FEISHU_CONFIG = {
  app_token: 'T7g4b0M4waf9OwsMc3pcJoqfnma',
  tables: {
    competitor_analysis: 'tblZQnvqkli68JUa',  // 竞品爆款拆解库
    finished_videos: 'tblpGj9b6S7rXrgb',       // 成片记录库
    framework: 'tblWiW6wv7gCf3O4',             // 框架结构库
    cta: 'tblGYDkGG3vfOedI',                   // 号召行动库 CTA
    pain_points: 'tblzWvaA9nAZBq2W',           // 痛点需求场景库
    comments: 'tbldmzhJ7UQxF9g9',              // 爆款评论库
    selling_points: 'tblUKBFDveaHCPYj',        // 卖点画面库
    social_proof: 'tblSxNDEnz2Dz8yf',          // 社会证明库
    benefits: 'tblR4QQPyhRQm388',              // 权益库
    bgm: 'tblFqgaECRD1wfZn'                    // BGM情绪库
  }
};

// ============ 工具函数 ============
function getMimeType(filename) {
  const ext = path.extname(filename).toLowerCase();
  const types = { '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.avi': 'video/x-msvideo', '.webm': 'video/webm' };
  return types[ext] || 'video/mp4';
}

function getVideoDuration(videoPath) {
  try {
    const result = execSync(
      `ffprobe -v error -show_entries format=duration -of csv=p=0 "${videoPath}"`,
      { encoding: 'utf-8', timeout: 30000 }
    );
    return parseFloat(result.trim());
  } catch (e) {
    console.error('ffprobe 获取时长失败:', e.message);
    return 0;
  }
}

function extractFrames(videoPath, videoId, shots) {
  const framesDir = path.join(__dirname, 'frames', videoId);
  if (!fs.existsSync(framesDir)) fs.mkdirSync(framesDir, { recursive: true });

  const frameResults = [];

  for (const shot of shots) {
    const shotNum = shot.shot_number || frameResults.length + 1;
    // 取镜头中间时间点截帧
    const startTime = parseFloat(shot.time_start) || 0;
    const endTime = parseFloat(shot.time_end) || startTime + 1;
    const midTime = (startTime + endTime) / 2;
    const outputFile = path.join(framesDir, `shot_${shotNum}.jpg`);

    try {
      execSync(
        `ffmpeg -y -ss ${midTime} -i "${videoPath}" -frames:v 1 -q:v 2 "${outputFile}"`,
        { timeout: 15000, stdio: 'pipe' }
      );
      if (fs.existsSync(outputFile)) {
        frameResults.push({
          shot_number: shotNum,
          frame_url: `/frames/${videoId}/shot_${shotNum}.jpg`,
          timestamp: midTime
        });
      }
    } catch (e) {
      console.error(`截帧失败 shot_${shotNum}:`, e.message);
      frameResults.push({ shot_number: shotNum, frame_url: '', timestamp: midTime });
    }
  }

  return frameResults;
}

// ============ API: 上传并分析视频（SSE） ============
app.post('/api/analyze', upload.single('video'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: '请上传视频文件' });

    const videoPath = req.file.path;
    const videoId = path.basename(videoPath, path.extname(videoPath));

    // SSE 头
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive'
    });

    const send = (step, message, data = null) => {
      res.write(`data: ${JSON.stringify({ step, message, data })}\n\n`);
    };

    send(1, '📁 视频上传成功，准备分析...');

    // Step 2: 获取视频时长
    send(2, '📐 正在获取视频信息...');
    const duration = getVideoDuration(videoPath);

    // Step 3: 发送给 Gemini
    send(3, '🔍 Gemini 2.5 Flash 正在逐帧分析视频...');
    const videoBuffer = fs.readFileSync(videoPath);
    const videoBase64 = videoBuffer.toString('base64');
    const mimeType = getMimeType(req.file.originalname);

    const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });

    const analysisPrompt = `你是一个专业的TikTok带货短视频拆解分析师。请对这个视频进行逐帧拆解分析。

请按以下JSON格式输出分析结果（严格JSON格式，不要有多余文字，不要用markdown代码块包裹）：

{
  "video_overview": {
    "total_duration_seconds": 视频总时长（秒数字）,
    "total_shots": 总镜头数（数字）,
    "product_first_appear_seconds": 产品首次出现时间（秒数字）,
    "product_exposure_seconds": 产品露出总时长（秒数字）,
    "product_exposure_ratio": 产品露出占比（百分比数字，如21）
  },
  "shots": [
    {
      "shot_number": 镜头编号（数字）,
      "time_start": "开始时间（秒数字）",
      "time_end": "结束时间（秒数字）",
      "shot_type": "镜头类型：痛点放大/产品展示/使用场景/细节特写/效果对比/行动引导/开箱展示/社交证明/情绪渲染",
      "scene_description": "画面描述（中文，详细描述画面内容）",
      "text_overlay": "画面上的文字/字幕（如果有，原文）",
      "voiceover": "口播内容（如果有，原文）",
      "product_visible": true或false
    }
  ],
  "script_structure": {
    "framework": "匹配的框架类型：经典痛点型/效果前置型/对比碾压型/多场景轰炸型/开箱种草型/好奇悬念型/社交证明型/科普权威型/真实体验型/剧情反转型",
    "formula": "底层公式，如：停→病→药→信→买",
    "hook_type": "开头钩子类型",
    "structure_breakdown": [
      {
        "element": "停/病/药/信/买",
        "time_range": "对应时间段",
        "description": "这一段做了什么",
        "shots_included": [对应的镜头编号数组]
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
  "reusable_points": ["可复用的亮点，每条一句话"],
  "optimization_suggestions": ["优化建议，每条一句话"]
}

请仔细分析每一帧画面，确保：
1. 镜头切割准确，每个场景变化都要识别
2. 画面上的文字和口播内容要完整提取
3. 脚本结构要准确匹配到"停病药信买"框架
4. 提取的素材要详细，可以直接用于填充素材库`;

    const result = await model.generateContent([
      { text: analysisPrompt },
      { inlineData: { mimeType, data: videoBase64 } }
    ]);

    const responseText = result.response.text();
    send(4, '📊 AI 分析完成，正在解析结果...');

    // 解析JSON
    let analysisResult;
    try {
      const jsonMatch = responseText.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        analysisResult = JSON.parse(jsonMatch[0]);
      } else {
        throw new Error('无法从AI响应中提取JSON');
      }
    } catch (parseError) {
      console.error('JSON解析失败:', parseError.message);
      console.error('原始响应前500字:', responseText.substring(0, 500));
      analysisResult = { raw_response: responseText, parse_error: true };
    }

    // Step 5: ffmpeg 截帧
    send(5, '🎞️ 正在提取镜头截图...');
    let frames = [];
    if (analysisResult.shots && analysisResult.shots.length > 0) {
      frames = extractFrames(videoPath, videoId, analysisResult.shots);
      // 把 frame_url 合并到 shots
      for (const frame of frames) {
        const shot = analysisResult.shots.find(s => s.shot_number === frame.shot_number);
        if (shot) shot.frame_url = frame.frame_url;
      }
    }

    send(6, '✅ 拆解完成！', {
      videoId,
      videoUrl: `/uploads/${req.file.filename}`,
      duration,
      analysis: analysisResult
    });

    // 延迟清理上传的视频文件（1小时后）
    setTimeout(() => {
      if (fs.existsSync(videoPath)) fs.unlinkSync(videoPath);
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

// ============ API: 跨品类改写（OpenRouter → Claude） ============
app.post('/api/rewrite', async (req, res) => {
  try {
    const { original_structure, new_category, product_name, core_selling_points } = req.body;

    if (!original_structure || !new_category || !product_name) {
      return res.status(400).json({ error: '缺少必要参数' });
    }

    const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY;
    if (!OPENROUTER_KEY) {
      return res.status(500).json({ error: 'OpenRouter API Key 未配置' });
    }

    const prompt = `你是一个专业的TikTok带货短视频脚本改编师。

以下是一条已拆解的爆款短视频脚本结构：

${JSON.stringify(original_structure, null, 2)}

请将这条脚本改编为新产品的版本：
- 新品类：${new_category}
- 产品名称：${product_name}
- 核心卖点：${core_selling_points || '请根据品类自行推断'}

要求：
1. 保持原视频的底层公式结构（停→病→药→信→买）不变
2. 把痛点场景替换为新品类的用户痛点
3. 把卖点展示替换为新产品的核心卖点
4. 把社会证明替换为新品类常用的信任元素
5. CTA话术适配新产品
6. 每个镜头都要给出：画面描述（中英文）、推荐镜头类型、文案/口播内容（英文）、文字叠加（英文）

请以JSON格式输出（严格JSON，不要markdown代码块）：
{
  "rewritten_shots": [
    {
      "shot_number": 镜头编号,
      "element": "停/病/药/信/买",
      "shot_type": "镜头类型",
      "scene_description_cn": "中文画面描述",
      "scene_description_en": "English scene description",
      "voiceover_en": "English voiceover script",
      "text_overlay_en": "English text overlay",
      "shooting_notes": "拍摄建议"
    }
  ],
  "summary": "改编要点总结（中文）"
}`;

    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENROUTER_KEY}`,
        'HTTP-Referer': 'https://tiktok-analyzer.zeabur.app',
        'X-Title': 'TikTok Video Analyzer'
      },
      body: JSON.stringify({
        model: 'anthropic/claude-sonnet-4',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 4096
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error('OpenRouter 错误:', errText);
      throw new Error(`OpenRouter API 错误: ${response.status}`);
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content || '';

    // 解析JSON
    let rewriteResult;
    try {
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        rewriteResult = JSON.parse(jsonMatch[0]);
      } else {
        rewriteResult = { raw_response: content };
      }
    } catch (e) {
      rewriteResult = { raw_response: content };
    }

    res.json({ success: true, rewrite: rewriteResult });

  } catch (error) {
    console.error('改写失败:', error);
    res.status(500).json({ error: '改写失败: ' + error.message });
  }
});

// ============ API: 写入飞书（Phase 2 预留） ============
app.post('/api/save-to-feishu', async (req, res) => {
  // TODO Phase 2: 将拆解结果写入飞书多维表格
  // 数据流向：
  // 1. 主记录 → 竞品爆款拆解库 (tblZQnvqkli68JUa)
  // 2. CTA话术 → 号召行动库 CTA (tblGYDkGG3vfOedI)
  // 3. 痛点场景 → 痛点需求场景库 (tblzWvaA9nAZBq2W)
  // 4. 卖点画面 → 卖点画面库 (tblUKBFDveaHCPYj)
  // 5. 社会证明 → 社会证明库 (tblSxNDEnz2Dz8yf)
  // 6. BGM → BGM情绪库 (tblFqgaECRD1wfZn)
  res.json({
    success: false,
    message: 'Phase 2 功能，尚未实现。飞书写入接口已预留。',
    config: FEISHU_CONFIG
  });
});

// ============ 健康检查 ============
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    gemini: !!process.env.GEMINI_API_KEY,
    openrouter: !!process.env.OPENROUTER_API_KEY,
    feishu_config: FEISHU_CONFIG
  });
});

// ============ 启动 ============
app.listen(PORT, () => {
  console.log(`🚀 爆款短视频拆解工具已启动: http://localhost:${PORT}`);
  console.log(`   Gemini API: ${process.env.GEMINI_API_KEY ? '✅' : '❌'}`);
  console.log(`   OpenRouter: ${process.env.OPENROUTER_API_KEY ? '✅' : '❌'}`);
});
