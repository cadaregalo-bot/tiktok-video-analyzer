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
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const FEISHU_APP_ID = process.env.FEISHU_APP_ID;
const FEISHU_APP_SECRET = process.env.FEISHU_APP_SECRET;
const KIE_API_KEY = process.env.KIE_API_KEY;
const FAL_API_KEY = process.env.FAL_API_KEY;

const FEISHU_CONFIG = {
  app_token: 'T7g4b0M4waf9OwsMc3pcJoqfnma',
  tables: {
    competitor: 'tblZQnvqkli68JUa', finished: 'tblpGj9b6S7rXrgb', framework: 'tblWiW6wv7gCf3O4',
    cta: 'tblGYDkGG3vfOedI', painpoint: 'tblzWvaA9nAZBq2W', comment: 'tbldmzhJ7UQxF9g9',
    sellingpt: 'tblUKBFDveaHCPYj', socialproof: 'tblSxNDEnz2Dz8yf', benefit: 'tblR4QQPyhRQm388', bgm: 'tblFqgaECRD1wfZn'
  }
};

const storage = multer.diskStorage({
  destination: (req, file, cb) => { const d = path.join(__dirname, 'uploads'); if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); cb(null, d); },
  filename: (req, file, cb) => { cb(null, `${uuidv4()}${path.extname(file.originalname)}`); }
});
const upload = multer({ storage, limits: { fileSize: 200 * 1024 * 1024 }, fileFilter: (req, file, cb) => { const ok = ['.mp4','.mov','.avi','.webm'].includes(path.extname(file.originalname).toLowerCase()); cb(ok ? null : new Error('不支持的格式'), ok); } });

app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.use('/frames', express.static(path.join(__dirname, 'frames')));

const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);

function getMimeType(f) { return { '.mp4':'video/mp4','.mov':'video/quicktime','.avi':'video/x-msvideo','.webm':'video/webm' }[path.extname(f).toLowerCase()] || 'video/mp4'; }

function extractFrames(videoPath, videoId, timePoints) {
  const dir = path.join(__dirname, 'frames', videoId);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const frames = [];
  for (let i = 0; i < timePoints.length; i++) {
    const t = timePoints[i], fn = `shot_${String(i+1).padStart(2,'0')}_${t.toFixed(1)}s.jpg`, out = path.join(dir, fn);
    try { execSync(`ffmpeg -y -ss ${t} -i "${videoPath}" -frames:v 1 -q:v 2 "${out}"`, { timeout: 15000, stdio: 'pipe' }); if (fs.existsSync(out)) frames.push({ index: i+1, time: t, url: `/frames/${videoId}/${fn}` }); } catch(e) {}
  }
  return frames;
}

function extractShotFrames(videoPath, videoId, shots) {
  return extractFrames(videoPath, videoId, shots.map(s => { const a = parseFloat(s.time_start)||0, b = parseFloat(s.time_end)||a; return parseFloat(((a+b)/2).toFixed(2)); }));
}

// === Feishu API ===
let feishuToken = { token: null, expires: 0 };
async function getFeishuToken() {
  if (feishuToken.token && Date.now() < feishuToken.expires) return feishuToken.token;
  const r = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ app_id: FEISHU_APP_ID, app_secret: FEISHU_APP_SECRET }) });
  const d = await r.json();
  if (d.code !== 0) throw new Error('飞书认证失败: ' + d.msg);
  feishuToken = { token: d.tenant_access_token, expires: Date.now() + (d.expire - 300) * 1000 };
  return feishuToken.token;
}
async function feishuCreate(tableId, fields) {
  const token = await getFeishuToken();
  const r = await fetch(`https://open.feishu.cn/open-apis/bitable/v1/apps/${FEISHU_CONFIG.app_token}/tables/${tableId}/records`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` }, body: JSON.stringify({ fields }) });
  const d = await r.json();
  if (d.code !== 0) throw new Error('飞书写入失败: ' + (d.msg || d.code));
  return d.data?.record;
}

function matchStructure(fw) { const f=(fw||'').toLowerCase(); if(f.includes('痛点'))return'痛点揭露+解决方案';if(f.includes('对比'))return'对比测试';if(f.includes('开箱'))return'开箱展示';if(f.includes('科普'))return'教程类';if(f.includes('真实'))return'日常vlog';if(f.includes('证明'))return'UGC买家秀';return'痛点揭露+解决方案'; }
function matchAction(a) { const m={'痛点共鸣':'痛点共鸣','提问触发':'提问触发','结果前置':'结果前置','反常识':'反常识','数字可信':'数字可信','场景代入':'场景代入','稀缺促单':'稀缺促单','损失厌恶':'损失厌恶','直接指令':'直接指令','权益利诱':'权益利诱'};return m[a]||'痛点共鸣'; }
function matchStage(t) { if(!t)return'开头（前3秒钩子）';if(t.includes('开头'))return'开头（前3秒钩子）';if(t.includes('中间'))return'中间（卖点引导）';if(t.includes('结尾'))return'结尾（促单转化）';return'开头（前3秒钩子）'; }

// === API: Analyze ===
app.post('/api/analyze', upload.single('video'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: '请上传视频文件' });
    const videoPath = req.file.path, videoId = path.basename(videoPath, path.extname(videoPath));
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
    const send = (step, message, data = null) => { res.write(`data: ${JSON.stringify({ step, message, data })}\n\n`); };

    send(1, '📁 视频上传成功');
    send(2, '🎬 ffmpeg 正在截取关键帧...');
    send(3, '🔍 Gemini AI 正在分析视频结构...');

    const videoBase64 = fs.readFileSync(videoPath).toString('base64');
    const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });

    const prompt = `你是一个专业的TikTok带货短视频拆解分析师。请对这个视频进行逐帧拆解分析。
请按以下JSON格式输出分析结果（严格JSON格式，不要有多余文字）：
{
  "video_overview": { "total_duration_seconds": 秒数, "total_shots": 数量, "product_first_appear_seconds": 秒数, "product_exposure_seconds": 秒数, "product_exposure_ratio": 百分比数字 },
  "shots": [{ "shot_number": 编号, "time_start": 秒数, "time_end": 秒数, "shot_type": "痛点放大/产品展示/使用场景/细节特写/效果对比/行动引导/开箱展示/社交证明/情绪渲染", "scene_description": "中文画面描述", "text_overlay": "画面文字", "voiceover": "口播内容", "product_visible": true或false }],
  "script_structure": { "framework": "经典痛点型/效果前置型/对比碾压型/多场景轰炸型/开箱种草型/好奇悬念型/社交证明型/科普权威型/真实体验型/剧情反转型", "formula": "如：停→病→药→信→买", "hook_type": "钩子类型", "structure_breakdown": [{ "element": "停/病/药/信/买", "time_range": "时间段", "description": "做了什么", "shots_included": [编号] }] },
  "extracted_materials": {
    "hook_scripts": [{"text":"原文","type":"开头/中间/结尾","action_type":"类型"}],
    "pain_points": [{"scene":"场景","user_pain":"痛点","emotion_keywords":["词"],"product_solution":"方案"}],
    "selling_points": [{"description":"卖点","visual_type":"画面类型","shooting_notes":"拍摄说明"}],
    "social_proof": [{"type":"类型","content":"内容"}],
    "cta_scripts": [{"text":"原文","type":"结尾促单","incentive":"权益"}],
    "bgm": {"mood":"情绪类型","description":"风格描述"}
  },
  "reusable_points": "可复用亮点",
  "optimization_suggestions": "优化建议"
}
要求：time_start和time_end必须是纯数字。`;

    const result = await model.generateContent([ { text: prompt }, { inlineData: { mimeType: getMimeType(req.file.originalname), data: videoBase64 } } ]);
    const responseText = result.response.text();
    send(4, '📊 AI 分析完成，解析结果...');

    let analysisResult;
    try { const m = responseText.match(/\{[\s\S]*\}/); analysisResult = m ? JSON.parse(m[0]) : { raw_response: responseText, parse_error: true }; }
    catch(e) { console.error('JSON解析失败:', e.message); analysisResult = { raw_response: responseText, parse_error: true }; }

    send(5, '📸 根据镜头时间点截帧...');
    if (analysisResult.shots && analysisResult.shots.length > 0) {
      const sf = extractShotFrames(videoPath, videoId, analysisResult.shots);
      for (let i = 0; i < analysisResult.shots.length; i++) { if (sf[i]) analysisResult.shots[i].frame_url = sf[i].url; }
    }

    send(6, '✅ 拆解完成！', { videoId, videoUrl: `/uploads/${req.file.filename}`, analysis: analysisResult });
    setTimeout(() => { try { if (fs.existsSync(videoPath)) fs.unlinkSync(videoPath); } catch(e){} }, 3600000);
    res.end();
  } catch (error) {
    console.error('分析失败:', error);
    if (!res.headersSent) res.status(500).json({ error: '分析失败: ' + error.message });
    else { res.write(`data: ${JSON.stringify({ step: -1, message: '❌ ' + error.message })}\n\n`); res.end(); }
  }
});

// === API: Rewrite ===
app.post('/api/rewrite', async (req, res) => {
  try {
    const { analysis, newCategory, productName, coreSellingPoints } = req.body;
    if (!OPENROUTER_API_KEY) return res.status(500).json({ error: 'OPENROUTER_API_KEY 未配置' });
    if (!analysis || !newCategory || !productName) return res.status(400).json({ error: '缺少参数' });
    const sb = analysis.script_structure?.structure_breakdown || [], shots = analysis.shots || [];
    const prompt = `你是TikTok带货短视频编导。基于以下爆款视频结构，为新产品改写视频脚本。

## 原始结构
框架：${analysis.script_structure?.framework||'未知'}
公式：${analysis.script_structure?.formula||'未知'}
分段：
${sb.map(b=>`[${b.element}] ${b.time_range||''}: ${b.description||''}`).join('\n')}
镜头：
${shots.map(s=>`#${s.shot_number} [${s.shot_type}] ${s.time_start}s-${s.time_end}s: ${s.scene_description||''}`).join('\n')}

## 新产品
品类：${newCategory}  名称：${productName}  卖点：${coreSellingPoints||'无'}

输出严格JSON：
{"rewritten_structure":[{"element":"停/病/药/信/买","shot_type":"镜头类型","scene_description_cn":"中文描述","scene_description_en":"English","voiceover_cn":"中文口播","voiceover_en":"English voiceover","text_overlay":"画面文字","shooting_notes":"拍摄建议"}],"hook_suggestion":"英文钩子","cta_suggestion":"英文CTA"}`;

    const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${OPENROUTER_API_KEY}`, 'HTTP-Referer': 'https://tiktok-analyzer.zeabur.app', 'X-Title': 'TikTok Analyzer' },
      body: JSON.stringify({ model: 'anthropic/claude-sonnet-4', max_tokens: 4096, messages: [{ role: 'user', content: prompt }] })
    });
    if (!r.ok) throw new Error(`OpenRouter ${r.status}`);
    const data = await r.json(), content = data.choices?.[0]?.message?.content || '';
    let rw; try { const m = content.match(/\{[\s\S]*\}/); rw = m ? JSON.parse(m[0]) : { raw_response: content }; } catch(e) { rw = { raw_response: content }; }
    res.json({ success: true, rewrite: rw });
  } catch (error) { console.error('改写失败:', error); res.status(500).json({ error: '改写失败: ' + error.message }); }
});

// === API: Feishu Save ===
app.post('/api/save-to-feishu', async (req, res) => {
  try {
    if (!FEISHU_APP_ID || !FEISHU_APP_SECRET) return res.status(500).json({ error: '飞书凭证未配置' });
    const { analysis, videoCode, videoUrl, filename } = req.body;
    if (!analysis) return res.status(400).json({ error: '缺少分析数据' });
    const a = analysis, ov = a.video_overview||{}, ss = a.script_structure||{}, em = a.extracted_materials||{};
    const results = { saved: [], errors: [] };

    // 1. 竞品爆款拆解库
    try {
      const hooks = (em.hook_scripts||[]).map(h=>h.text).join('\n');
      const reuse = typeof a.reusable_points==='string' ? a.reusable_points : JSON.stringify(a.reusable_points||'');
      const bgm = em.bgm ? `${em.bgm.mood||''} - ${em.bgm.description||''}` : '';
      await feishuCreate(FEISHU_CONFIG.tables.competitor, {
        '视频标题/描述': filename||'未命名', '视频编码': videoCode||'', '钩子话术': hooks,
        '视频结构': matchStructure(ss.framework), '使用BGM': bgm, '可复用点': reuse,
        '拆解状态': '已拆解', '拆解时间': Date.now(),
        ...(videoUrl ? { '视频文件地址': { link: videoUrl, text: videoUrl } } : {})
      });
      results.saved.push({ table: '竞品爆款拆解库' });
    } catch(e) { results.errors.push({ table: '竞品爆款拆解库', error: e.message }); }

    // 2. CTA库
    const allCTA = [...(em.hook_scripts||[]), ...(em.cta_scripts||[]).map(c=>({text:c.text,type:'结尾',action_type:'稀缺促单'}))];
    for (const c of allCTA) {
      try { await feishuCreate(FEISHU_CONFIG.tables.cta, { 'CTA话术（英文）': c.text||'', '中文翻译': c.text||'', '视频阶段': matchStage(c.type), '行动类型': matchAction(c.action_type), '话术逻辑': `拆解提取-${filename||''}` }); results.saved.push({ table: 'CTA库' }); }
      catch(e) { results.errors.push({ table: 'CTA库', error: e.message }); }
    }

    // 3. 痛点库
    for (const p of (em.pain_points||[])) {
      try { await feishuCreate(FEISHU_CONFIG.tables.painpoint, { '场景名称': p.scene||p.user_pain||'', '用户痛点': p.user_pain||'', '产品切入点': p.product_solution||'', '来源': 'TikTok爆款' }); results.saved.push({ table: '痛点库' }); }
      catch(e) { results.errors.push({ table: '痛点库', error: e.message }); }
    }

    // 4. 卖点画面库
    for (const s of (em.selling_points||[])) {
      try { await feishuCreate(FEISHU_CONFIG.tables.sellingpt, { '拍摄说明': s.shooting_notes||s.description||'', '画面类型': s.visual_type||'', '作用': s.description||'' }); results.saved.push({ table: '卖点库' }); }
      catch(e) { results.errors.push({ table: '卖点库', error: e.message }); }
    }

    // 5. 社会证明库
    for (const s of (em.social_proof||[])) {
      try { await feishuCreate(FEISHU_CONFIG.tables.socialproof, { '证明类型': s.type||'', '素材名称': s.content||'', '使用建议': `拆解提取-${filename||''}` }); results.saved.push({ table: '社会证明库' }); }
      catch(e) { results.errors.push({ table: '社会证明库', error: e.message }); }
    }

    res.json({ success: results.errors.length===0, message: `写入完成：${results.saved.length}条成功${results.errors.length>0?'，'+results.errors.length+'条失败':''}`, results });
  } catch (error) { console.error('飞书入库失败:', error); res.status(500).json({ error: '飞书入库失败: ' + error.message }); }
});

// === API: Feishu List Records (for BGM library) ===
async function feishuList(tableId, opts = {}) {
  const token = await getFeishuToken();
  const params = new URLSearchParams();
  if (opts.page_size) params.set('page_size', opts.page_size);
  if (opts.page_token) params.set('page_token', opts.page_token);
  const url = `https://open.feishu.cn/open-apis/bitable/v1/apps/${FEISHU_CONFIG.app_token}/tables/${tableId}/records?${params}`;
  const r = await fetch(url, { headers: { 'Authorization': `Bearer ${token}` } });
  const d = await r.json();
  if (d.code !== 0) throw new Error('飞书读取失败: ' + (d.msg || d.code));
  return d.data;
}

app.get('/api/feishu/bgm', async (req, res) => {
  try {
    if (!FEISHU_APP_ID || !FEISHU_APP_SECRET) return res.status(500).json({ error: '飞书未配置' });
    const data = await feishuList(FEISHU_CONFIG.tables.bgm, { page_size: 100 });
    const items = (data.items || []).map(r => ({
      name: r.fields['BGM名称'] || '',
      mood: r.fields['情绪类型'] || '',
      content: r.fields['适用内容'] || '',
      description: r.fields['特征描述'] || ''
    })).filter(i => i.name);
    res.json({ success: true, bgm: items });
  } catch (e) { console.error('BGM读取失败:', e); res.status(500).json({ error: e.message }); }
});

// === API: Video Generation Platforms ===
app.get('/api/videogen/platforms', (req, res) => {
  res.json({
    platforms: [
      { id: 'kie', name: 'Kie.ai', available: !!KIE_API_KEY, models: [
        { id: 'veo3_fast', name: 'Veo 3.1 Fast', price: '~$0.30/8s', speed: '快', quality: '标准' },
        { id: 'veo3', name: 'Veo 3.1 Quality', price: '~$2.00/8s', speed: '慢', quality: '高' }
      ]},
      { id: 'fal', name: 'fal.ai', available: !!FAL_API_KEY, models: [
        { id: 'fal-ai/veo3/fast', name: 'Veo 3 Fast', price: '~$0.10-0.15/s', speed: '快', quality: '标准' },
        { id: 'fal-ai/veo3', name: 'Veo 3 Quality', price: '~$0.20-0.40/s', speed: '慢', quality: '高' }
      ]}
    ]
  });
});

// In-memory task store for video gen polling
const videoTasks = new Map();

// === Kie.ai Video Generation ===
async function kieGenerate(prompt, model, aspectRatio) {
  const r = await fetch('https://api.kie.ai/api/v1/veo/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${KIE_API_KEY}` },
    body: JSON.stringify({
      prompt,
      model: model || 'veo3_fast',
      aspect_ratio: aspectRatio || '9:16',
      watermark: '',
      enableTranslation: true
    })
  });
  const d = await r.json();
  if (d.code !== 200 && d.code !== 0) throw new Error('Kie.ai 提交失败: ' + (d.msg || JSON.stringify(d)));
  return { taskId: d.data?.task_id || d.task_id, platform: 'kie' };
}

async function kieGetStatus(taskId) {
  const r = await fetch(`https://api.kie.ai/api/v1/veo/record-detail?taskId=${taskId}`, {
    headers: { 'Authorization': `Bearer ${KIE_API_KEY}` }
  });
  const d = await r.json();
  const status = d.data?.status || d.data?.task_status || 'unknown';
  const isComplete = status === 'completed' || status === 'success' || !!d.data?.video_url;
  const isFailed = status === 'failed' || status === 'error';
  return {
    status: isComplete ? 'completed' : isFailed ? 'failed' : 'processing',
    videoUrl: d.data?.video_url || d.data?.output?.video_url || null,
    coverUrl: d.data?.image_url || d.data?.cover_url || null,
    raw: d.data
  };
}

// === fal.ai Video Generation ===
async function falGenerate(prompt, model, aspectRatio) {
  const endpoint = model || 'fal-ai/veo3/fast';
  const r = await fetch(`https://queue.fal.run/${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Key ${FAL_API_KEY}` },
    body: JSON.stringify({
      prompt,
      aspect_ratio: aspectRatio || '9:16',
      duration: '8s',
      resolution: '720p',
      generate_audio: true
    })
  });
  if (!r.ok) { const e = await r.text(); throw new Error('fal.ai 提交失败: ' + e); }
  const d = await r.json();
  return { taskId: d.request_id, platform: 'fal', endpoint };
}

async function falGetStatus(taskId, endpoint) {
  const r = await fetch(`https://queue.fal.run/${endpoint}/requests/${taskId}/status`, {
    headers: { 'Authorization': `Key ${FAL_API_KEY}` }
  });
  const d = await r.json();
  if (d.status === 'COMPLETED') {
    // Fetch actual result
    const rr = await fetch(`https://queue.fal.run/${endpoint}/requests/${taskId}`, {
      headers: { 'Authorization': `Key ${FAL_API_KEY}` }
    });
    const result = await rr.json();
    return { status: 'completed', videoUrl: result.video?.url || null, coverUrl: null, raw: result };
  }
  if (d.status === 'FAILED') return { status: 'failed', videoUrl: null, raw: d };
  return { status: 'processing', videoUrl: null, raw: d };
}

// === API: Submit video generation ===
app.post('/api/videogen/generate', async (req, res) => {
  try {
    const { prompt, platform, model, aspectRatio } = req.body;
    if (!prompt) return res.status(400).json({ error: '缺少 prompt' });

    let result;
    if (platform === 'fal') {
      if (!FAL_API_KEY) return res.status(500).json({ error: 'FAL_API_KEY 未配置' });
      result = await falGenerate(prompt, model, aspectRatio);
    } else {
      if (!KIE_API_KEY) return res.status(500).json({ error: 'KIE_API_KEY 未配置' });
      result = await kieGenerate(prompt, model, aspectRatio);
    }

    // Store task for polling
    const taskKey = `${result.platform}_${result.taskId}`;
    videoTasks.set(taskKey, { ...result, createdAt: Date.now(), prompt });

    // Auto-cleanup after 2 hours
    setTimeout(() => videoTasks.delete(taskKey), 7200000);

    res.json({ success: true, taskId: result.taskId, platform: result.platform, taskKey });
  } catch (e) { console.error('视频生成提交失败:', e); res.status(500).json({ error: e.message }); }
});

// === API: Poll video generation status ===
app.get('/api/videogen/status/:taskKey', async (req, res) => {
  try {
    const { taskKey } = req.params;
    const task = videoTasks.get(taskKey);
    if (!task) return res.status(404).json({ error: '任务不存在或已过期' });

    let status;
    if (task.platform === 'fal') {
      status = await falGetStatus(task.taskId, task.endpoint);
    } else {
      status = await kieGetStatus(task.taskId);
    }

    res.json({ success: true, ...status, taskKey });
  } catch (e) { console.error('状态查询失败:', e); res.status(500).json({ error: e.message }); }
});

// === Health ===
app.get('/api/health', (req, res) => {
  let ffmpeg = false; try { execSync('ffmpeg -version', { stdio:'pipe', timeout:5000 }); ffmpeg = true; } catch(e) {}
  res.json({ status: 'ok', timestamp: new Date().toISOString(), services: { gemini: !!GEMINI_API_KEY, openrouter: !!OPENROUTER_API_KEY, feishu: !!(FEISHU_APP_ID&&FEISHU_APP_SECRET), ffmpeg, kie: !!KIE_API_KEY, fal: !!FAL_API_KEY } });
});

app.listen(PORT, () => { console.log(`🚀 http://localhost:${PORT}  Gemini:${GEMINI_API_KEY?'✅':'❌'} OpenRouter:${OPENROUTER_API_KEY?'✅':'❌'} 飞书:${FEISHU_APP_ID?'✅':'❌'} Kie:${KIE_API_KEY?'✅':'❌'} Fal:${FAL_API_KEY?'✅':'❌'}`); });
