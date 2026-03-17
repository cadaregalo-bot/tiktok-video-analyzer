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

// ============ 配置 ============
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const FEISHU_APP_ID = process.env.FEISHU_APP_ID;
const FEISHU_APP_SECRET = process.env.FEISHU_APP_SECRET;

const FEISHU_CONFIG = {
  app_token: 'T7g4b0M4waf9OwsMc3pcJoqfnma',
  tables: {
    competitor:  'tblZQnvqkli68JUa',
    finished:    'tblpGj9b6S7rXrgb',
    framework:   'tblWiW6wv7gCf3O4',
    cta:         'tblGYDkGG3vfOedI',
    painpoint:   'tblzWvaA9nAZBq2W',
    comment:     'tbldmzhJ7UQxF9g9',
    sellingpt:   'tblUKBFDveaHCPYj',
    socialproof: 'tblSxNDEnz2Dz8yf',
    benefit:     'tblR4QQPyhRQm388',
    bgm:         'tblFqgaECRD1wfZn',
  }
};

// Multer
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
    const allowed = ['.mp4', '.mov', '.avi', '.webm'];
    if (allowed.includes(path.extname(file.originalname).toLowerCase())) cb(null, true);
    else cb(new Error('不支持的文件格式'));
  }
});

// 中间件
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.use('/frames', express.static(path.join(__dirname, 'frames')));

const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);

// ============ 工具函数 ============
function getMimeType(filename) {
  const ext = path.extname(filename).toLowerCase();
  return { '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.avi': 'video/x-msvideo', '.webm': 'video/webm' }[ext] || 'video/mp4';
}

function getVideoDuration(videoPath) {
  try {
    const r = execSync(`ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${videoPath}"`, { encoding: 'utf-8', timeout: 30000 });
    return parseFloat(r.trim());
  } catch (e) { return 0; }
}

function extractFrames(videoPath, videoId, timePoints) {
  const framesDir = path.join(__dirname, 'frames', videoId);
  if (!fs.existsSync(framesDir)) fs.mkdirSync(framesDir, { recursive: true });
  const frames = [];
  for (let i = 0; i < timePoints.length; i++) {
    const t = timePoints[i];
    const filename = `shot_${String(i + 1).padStart(2, '0')}_${t.toFixed(1)}s.jpg`;
    const outputPath = path.join(framesDir, filename);
    try {
      execSync(`ffmpeg -y -ss ${t} -i "${videoPath}" -frames:v 1 -q:v 2 "${outputPath}"`, { timeout: 15000, stdio: 'pipe' });
      if (fs.existsSync(outputPath)) frames.push({ index: i + 1, time: t, filename, url: `/frames/${videoId}/${filename}` });
    } catch (e) { console.warn(`截帧失败 t=${t}s`); }
  }
  return frames;
}

function extractShotFrames(videoPath, videoId, shots) {
  const timePoints = shots.map(s => {
    const start = parseFloat(s.time_start) || 0;
    const end = parseFloat(s.time_end) || start;
    return parseFloat(((start + end) / 2).toFixed(2));
  });
  return extractFrames(videoPath, videoId, timePoints);
}

// ============ 飞书 API 工具 ============

// 获取 tenant_access_token
let feishuTokenCache = { token: null, expires: 0 };

async function getFeishuToken() {
  if (feishuTokenCache.token && Date.now() < feishuTokenCache.expires) {
    return feishuTokenCache.token;
  }
  const resp = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: FEISHU_APP_ID, app_secret: FEISHU_APP_SECRET })
  });
  const data = await resp.json();
  if (data.code !== 0) throw new Error('飞书认证失败: ' + (data.msg || JSON.stringify(data)));
  feishuTokenCache = {
    token: data.tenant_access_token,
    expires: Date.now() + (data.expire - 300) * 1000 // 提前5分钟过期
  };
  return feishuTokenCache.token;
}

// 写入飞书多维表格记录
async function feishuCreateRecord(tableId, fields) {
  const token = await getFeishuToken();
  const resp = await fetch(`https://open.feishu.cn/open-apis/bitable/v1/apps/${FEISHU_CONFIG.app_token}/tables/${tableId}/records`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`
    },
    body: JSON.stringify({ fields })
  });
  const data = await resp.json();
  if (data.code !== 0) {
    console.error('飞书写入失败:', JSON.stringify(data));
    throw new Error('飞书写入失败: ' + (data.msg || `code=${data.code}`));
  }
  return data.data?.record;
}

// 匹配视频结构到飞书单选选项
function matchVideoStructure(framework) {
  const f = (framework || '').toLowerCase();
  if (f.includes('痛点') && f.includes('解决')) return '痛点揭露+解决方案';
  if (f.includes('对比')) return '对比测试';
  if (f.includes('开箱')) return '开箱展示';
  if (f.includes('教程') || f.includes('科普')) return '教程类';
  if (f.includes('真实') || f.includes('体验') || f.includes('vlog')) return '日常vlog';
  if (f.includes('证明') || f.includes('UGC')) return 'UGC买家秀';
  return '痛点揭露+解决方案'; // 默认
}

// 匹配CTA行动类型到飞书单选选项
function matchActionType(actionType) {
  const map = {
    '痛点共鸣': '痛点共鸣', '提问触发': '提问触发', '结果前置': '结果前置',
    '反常识': '反常识', '数字可信': '数字可信', '场景代入': '场景代入',
    '稀缺促单': '稀缺促单', '损失厌恶': '损失厌恶', '直接指令': '直接指令',
    '权益利诱': '权益利诱', '产品演示': '产品演示', '对比引导': '对比引导',
    '用户证言': '用户证言', '社交证明': '社交证明', '对比锚定': '对比锚定'
  };
  return map[actionType] || '痛点共鸣';
}

// 匹配CTA视频阶段
function matchVideoStage(type) {
  if (!type) return '开头（前3秒钩子）';
  if (type.includes('开头')) return '开头（前3秒钩子）';
  if (type.includes('中间')) return '中间（卖点引导）';
  if (type.includes('结尾')) return '结尾（促单转化）';
  return '开头（前3秒钩子）';
}

// ============ API: 分析视频 ============
app.post('/api/analyze', upload.single('video'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: '请上传视频文件' });
    const videoPath = req.file.path;
    const videoId = path.basename(videoPath, path.extname(videoPath));

    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
    const send = (step, message, data = null) => { res.write(`data: ${JSON.stringify({ step, message, data })}\n\n`); };

    send(1, '📁 视频上传成功');
    send(2, '🎬 ffmpeg 正在截取关键帧...');

    send(3, '🔍 Gemini AI 正在分析视频结构...');
    const videoBuffer = fs.readFileSync(videoPath);
    const videoBase64 = videoBuffer.toString('base64');
    const mimeType = getMimeType(req.file.originalname);
    const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });

    const analysisPrompt = `你是一个专业的TikTok带货短视频拆解分析师。请对这个视频进行逐帧拆解分析。

请按以下JSON格式输出分析结果（严格JSON格式，不要有多余文字）：

{
  "video_overview": {
    "total_duration_seconds": 视频总时长秒数,
    "total_shots": 总镜头数,
    "product_first_appear_seconds": 产品首次出现秒数,
    "product_exposure_seconds": 产品露出总时长秒数,
    "product_exposure_ratio": 产品露出占比百分比数字
  },
  "shots": [
    {
      "shot_number": 镜头编号,
      "time_start": 开始秒数,
      "time_end": 结束秒数,
      "shot_type": "痛点放大/产品展示/使用场景/细节特写/效果对比/行动引导/开箱展示/社交证明/情绪渲染",
      "scene_description": "中文画面描述",
      "text_overlay": "画面文字原文",
      "voiceover": "口播原文",
      "product_visible": true或false
    }
  ],
  "script_structure": {
    "framework": "经典痛点型/效果前置型/对比碾压型/多场景轰炸型/开箱种草型/好奇悬念型/社交证明型/科普权威型/真实体验型/剧情反转型",
    "formula": "如：停→病→药→信→买",
    "hook_type": "痛点冲击/效果冲击/好奇悬念/社交证明/真实场景/知识科普/冲突反转/开箱惊喜/对比冲击",
    "structure_breakdown": [
      {
        "element": "停/病/药/信/买",
        "time_range": "时间段",
        "description": "做了什么",
        "shots_included": [镜头编号数组]
      }
    ]
  },
  "extracted_materials": {
    "hook_scripts": [{"text":"原文","type":"开头/中间/结尾","action_type":"类型"}],
    "pain_points": [{"scene":"场景","user_pain":"痛点","emotion_keywords":["情绪词"],"product_solution":"解决方案"}],
    "selling_points": [{"description":"卖点","visual_type":"画面类型","shooting_notes":"拍摄说明"}],
    "social_proof": [{"type":"类型","content":"内容"}],
    "cta_scripts": [{"text":"原文","type":"结尾促单","incentive":"权益"}],
    "bgm": {"mood":"情绪类型","description":"风格描述"}
  },
  "reusable_points": "可复用亮点（1-3条）",
  "optimization_suggestions": "优化建议（1-2条）"
}

要求：time_start和time_end必须是纯数字。镜头切割要准确。`;

    const result = await model.generateContent([
      { text: analysisPrompt },
      { inlineData: { mimeType, data: videoBase64 } }
    ]);

    const responseText = result.response.text();
    send(4, '📊 AI 分析完成，解析结果...');

    let analysisResult;
    try {
      const jsonMatch = responseText.match(/\{[\s\S]*\}/);
      if (jsonMatch) analysisResult = JSON.parse(jsonMatch[0]);
      else throw new Error('无法提取JSON');
    } catch (e) {
      console.error('JSON解析失败:', e.message);
      analysisResult = { raw_response: responseText, parse_error: true };
    }

    send(5, '📸 根据镜头时间点截帧...');
    if (analysisResult.shots && analysisResult.shots.length > 0) {
      const shotFrames = extractShotFrames(videoPath, videoId, analysisResult.shots);
      for (let i = 0; i < analysisResult.shots.length; i++) {
        if (shotFrames[i]) analysisResult.shots[i].frame_url = shotFrames[i].url;
      }
    }

    send(6, '✅ 拆解完成！', { videoId, videoUrl: `/uploads/${req.file.filename}`, analysis: analysisResult });
    setTimeout(() => { if (fs.existsSync(videoPath)) fs.unlinkSync(videoPath); }, 3600000);
    res.end();

  } catch (error) {
    console.error('分析失败:', error);
    if (!res.headersSent) res.status(500).json({ error: '分析失败: ' + error.message });
    else { res.write(`data: ${JSON.stringify({ step: -1, message: '❌ ' + error.message })}\n\n`); res.end(); }
  }
});

// ============ API: 跨品类改写 ============
app.post('/api/rewrite', async (req, res) => {
  try {
    const { analysis, newCategory, productName, coreSellingPoints } = req.body;
    if (!OPENROUTER_API_KEY) return res.status(500).json({ error: 'OPENROUTER_API_KEY 未配置' });
    if (!analysis || !newCategory || !productName) return res.status(400).json({ error: '缺少参数' });

    const sb = analysis.script_structure?.structure_breakdown || [];
    const shots = analysis.shots || [];

    const prompt = `你是TikTok带货短视频编导。基于以下爆款视频结构，为新产品改写视频脚本。

## 原始结构
框架：${analysis.script_structure?.framework || '未知'}
公式：${analysis.script_structure?.formula || '未知'}
分段：
${sb.map(b => `[${b.element}] ${b.time_range||''}: ${b.description||''}`).join('\n')}

镜头：
${shots.map(s => `#${s.shot_number} [${s.shot_type}] ${s.time_start}s-${s.time_end}s: ${s.scene_description||''}`).join('\n')}

## 新产品
品类：${newCategory}
名称：${productName}
卖点：${coreSellingPoints || '无'}

输出严格JSON：
{
  "rewritten_structure": [
    {
      "element": "停/病/药/信/买",
      "shot_type": "镜头类型",
      "scene_description_cn": "中文描述",
      "scene_description_en": "English description",
      "voiceover_cn": "中文口播",
      "voiceover_en": "English voiceover",
      "text_overlay": "画面文字",
      "shooting_notes": "拍摄建议"
    }
  ],
  "hook_suggestion": "英文开头钩子建议",
  "cta_suggestion": "英文结尾促单建议"
}`;

    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
        'HTTP-Referer': 'https://tiktok-analyzer.zeabur.app',
        'X-Title': 'TikTok Video Analyzer'
      },
      body: JSON.stringify({
        model: 'anthropic/claude-sonnet-4-20250514',
        max_tokens: 4000,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    if (!response.ok) throw new Error(`OpenRouter ${response.status}`);
    const data = await response.json();
    const content = data.choices?.[0]?.message?.content || '';

    let rewriteResult;
    try {
      const m = content.match(/\{[\s\S]*\}/);
      rewriteResult = m ? JSON.parse(m[0]) : { raw_response: content };
    } catch (e) { rewriteResult = { raw_response: content }; }

    res.json({ success: true, rewrite: rewriteResult });
  } catch (error) {
    console.error('改写失败:', error);
    res.status(500).json({ error: '改写失败: ' + error.message });
  }
});

// ============ API: 飞书入库 ============
app.post('/api/save-to-feishu', async (req, res) => {
  try {
    if (!FEISHU_APP_ID || !FEISHU_APP_SECRET) {
      return res.status(500).json({ error: '飞书 APP_ID 或 APP_SECRET 未配置' });
    }

    const { analysis, videoCode, videoUrl, filename } = req.body;
    if (!analysis) return res.status(400).json({ error: '缺少分析数据' });

    const a = analysis;
    const ov = a.video_overview || {};
    const ss = a.script_structure || {};
    const em = a.extracted_materials || {};
    const results = { saved: [], errors: [] };

    // 1. 写入竞品爆款拆解库（主记录）
    try {
      const hookTexts = (em.hook_scripts || []).map(h => h.text).join('\n');
      const reusable = typeof a.reusable_points === 'string' ? a.reusable_points : JSON.stringify(a.reusable_points || '');
      const bgmDesc = em.bgm ? `${em.bgm.mood || ''} - ${em.bgm.description || ''}` : '';

      const mainRecord = await feishuCreateRecord(FEISHU_CONFIG.tables.competitor, {
        '视频标题/描述': filename || '未命名视频',
        '视频编码': videoCode || '',
        '钩子话术': hookTexts,
        '视频结构': matchVideoStructure(ss.framework),
        '使用BGM': bgmDesc,
        '可复用点': reusable,
        '拆解状态': '已拆解',
        '拆解时间': Date.now(),
        ...(videoUrl ? { '视频文件地址': { link: videoUrl, text: videoUrl } } : {})
      });
      results.saved.push({ table: '竞品爆款拆解库', recordId: mainRecord?.record_id });
    } catch (e) {
      console.error('写入竞品拆解库失败:', e.message);
      results.errors.push({ table: '竞品爆款拆解库', error: e.message });
    }

    // 2. 写入号召行动库 CTA
    const allCTA = [
      ...(em.hook_scripts || []),
      ...(em.cta_scripts || []).map(c => ({ text: c.text, type: '结尾', action_type: '稀缺促单' }))
    ];
    for (const cta of allCTA) {
      try {
        await feishuCreateRecord(FEISHU_CONFIG.tables.cta, {
          'CTA话术（英文）': cta.text || '',
          '中文翻译': cta.text || '',
          '视频阶段': matchVideoStage(cta.type),
          '行动类型': matchActionType(cta.action_type),
          '话术逻辑': `从视频拆解提取 - ${filename || ''}`,
          ...(videoUrl ? { '参考视频链接': { link: videoUrl, text: videoUrl } } : {})
        });
        results.saved.push({ table: '号召行动库 CTA', text: (cta.text || '').substring(0, 30) });
      } catch (e) {
        results.errors.push({ table: '号召行动库 CTA', error: e.message });
      }
    }

    // 3. 写入痛点需求场景库
    for (const pp of (em.pain_points || [])) {
      try {
        await feishuCreateRecord(FEISHU_CONFIG.tables.painpoint, {
          '场景名称': pp.scene || pp.user_pain || '未命名场景',
          '用户痛点': pp.user_pain || '',
          '产品切入点': pp.product_solution || '',
          '内容角度建议': `从视频拆解提取`,
          '来源': 'TikTok爆款'
        });
        results.saved.push({ table: '痛点需求场景库', scene: (pp.scene || '').substring(0, 30) });
      } catch (e) {
        results.errors.push({ table: '痛点需求场景库', error: e.message });
      }
    }

    // 4. 写入卖点画面库
    for (const sp of (em.selling_points || [])) {
      try {
        await feishuCreateRecord(FEISHU_CONFIG.tables.sellingpt, {
          '拍摄说明': sp.shooting_notes || sp.description || '',
          '画面类型': sp.visual_type || '',
          '作用': sp.description || ''
        });
        results.saved.push({ table: '卖点画面库', desc: (sp.description || '').substring(0, 30) });
      } catch (e) {
        results.errors.push({ table: '卖点画面库', error: e.message });
      }
    }

    // 5. 写入社会证明库
    for (const sp of (em.social_proof || [])) {
      try {
        await feishuCreateRecord(FEISHU_CONFIG.tables.socialproof, {
          '证明类型': sp.type || '',
          '素材名称': sp.content || '',
          '使用建议': `从视频拆解提取 - ${filename || ''}`
        });
        results.saved.push({ table: '社会证明库', type: sp.type });
      } catch (e) {
        results.errors.push({ table: '社会证明库', error: e.message });
      }
    }

    const totalSaved = results.saved.length;
    const totalErrors = results.errors.length;

    res.json({
      success: totalErrors === 0,
      message: `写入完成：${totalSaved} 条成功${totalErrors > 0 ? `，${totalErrors} 条失败` : ''}`,
      results
    });

  } catch (error) {
    console.error('飞书入库失败:', error);
    res.status(500).json({ error: '飞书入库失败: ' + error.message });
  }
});

// ============ 健康检查 ============
app.get('/api/health', (req, res) => {
  let ffmpegOk = false;
  try { execSync('ffmpeg -version', { stdio: 'pipe', timeout: 5000 }); ffmpegOk = true; } catch (e) {}
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    services: {
      gemini: !!GEMINI_API_KEY,
      openrouter: !!OPENROUTER_API_KEY,
      feishu: !!(FEISHU_APP_ID && FEISHU_APP_SECRET),
      ffmpeg: ffmpegOk
    }
  });
});

// ============ 启动 ============
app.listen(PORT, () => {
  console.log(`🚀 爆款短视频拆解工具: http://localhost:${PORT}`);
  console.log(`   Gemini: ${GEMINI_API_KEY ? '✅' : '❌'}  OpenRouter: ${OPENROUTER_API_KEY ? '✅' : '❌'}  飞书: ${FEISHU_APP_ID ? '✅' : '❌'}`);
});
