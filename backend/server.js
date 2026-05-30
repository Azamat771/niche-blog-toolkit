'use strict';
/*
 * niche-blog-toolkit — backend.
 * Endpoints:
 *   POST /api/generate — fresh post idea (structured JSON: hook/shoot/...).
 *   POST /api/agent    — SMM and UGC agents (action → markdown response).
 *   GET  /api/health   — status + spend + trend cache age.
 * LLM: DeepSeek (OpenAI-compatible). Trends: Tavily (cached 12h).
 * Zero-dependency. Protections: CORS + shared-token + per-IP rate-limit + daily cost-cap.
 *
 * All niche-specific texts (niche, audience, tone, rubrics, trend query) come from a
 * NICHE_CONFIG JSON file (path in env). See ../config/niche.schema.json.
 */
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

/* ---------- .env ---------- */
function loadEnv() {
  const p = path.join(__dirname, '.env');
  try {
    fs.readFileSync(p, 'utf8').split('\n').forEach(line => {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && process.env[m[1]] === undefined) {
        let v = m[2].trim();
        if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
        process.env[m[1]] = v;
      }
    });
  } catch (e) {}
}
loadEnv();

/* ---------- niche config ---------- */
const NICHE_PATH = process.env.NICHE_CONFIG || path.join(__dirname, '..', 'config', 'default.niche.json');
let NICHE = {};
try { NICHE = JSON.parse(fs.readFileSync(NICHE_PATH, 'utf8')); }
catch (e) { console.error('Cannot read NICHE_CONFIG at', NICHE_PATH, '-', e.message); process.exit(1); }
const VALID_RUBRICS = (NICHE.rubrics || []).map(r => r.id);
const VALID_FORMATS = ['Reels', 'Карусель', 'Пост', 'Stories'];

const CFG = {
  apiKey: process.env.DEEPSEEK_API_KEY || '',
  baseUrl: process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com',
  model: process.env.MODEL || 'deepseek-chat',
  tavilyKey: process.env.TAVILY_API_KEY || '',
  dailyCapUsd: parseFloat(process.env.DAILY_CAP_USD || '0.50'),
  port: parseInt(process.env.PORT || '3007', 10),
  allowedOrigin: process.env.ALLOWED_ORIGIN || '*',
  sharedToken: process.env.SHARED_TOKEN || '',
  priceIn: parseFloat(process.env.PRICE_IN || '0.14'),
  priceOut: parseFloat(process.env.PRICE_OUT || '0.28'),
};

/* ---------- rate-limit + cost-cap ---------- */
const ipHits = new Map();
const RL_WINDOW_MS = 60 * 1000, RL_MAX = 10;
let spend = { day: dayKey(), usd: 0 };
function dayKey() { const d = new Date(); return d.getUTCFullYear() + '-' + (d.getUTCMonth() + 1) + '-' + d.getUTCDate(); }
function rollDay() { const k = dayKey(); if (k !== spend.day) spend = { day: k, usd: 0 }; }
function rateLimited(ip) {
  const now = Date.now();
  const arr = (ipHits.get(ip) || []).filter(t => now - t < RL_WINDOW_MS);
  if (arr.length >= RL_MAX) { ipHits.set(ip, arr); return true; }
  arr.push(now); ipHits.set(ip, arr); return false;
}
function chargeUsage(u) {
  u = u || {};
  spend.usd += ((u.prompt_tokens || 700) * CFG.priceIn + (u.completion_tokens || 700) * CFG.priceOut) / 1e6;
}

/* ---------- trends (Tavily + season) ---------- */
const RU_MONTHS = ['января','февраля','марта','апреля','мая','июня','июля','августа','сентября','октября','ноября','декабря'];
function todayStr() { const d = new Date(); return d.getDate() + ' ' + RU_MONTHS[d.getMonth()] + ' ' + d.getFullYear() + ' г.'; }
function seasonContext() {
  const m = new Date().getMonth();
  if (m >= 2 && m <= 4)  return 'весна — пробуждение, новый старт, активность; конец весны — готовимся к лету';
  if (m >= 5 && m <= 7)  return 'лето — отпуска, жара, лёгкость, путешествия, ритм отдыха';
  if (m >= 8 && m <= 10) return 'осень — возврат к рутине, подготовка к холоду, рост вовлечения после лета';
  return 'зима — праздники, итоги года, новогодний ажиотаж, потом — поствыходные январь';
}

const TREND_TTL_MS = 12 * 3600 * 1000;
const TREND_FILE = path.join(__dirname, 'trends-cache.json');
let trendCache = { ts: 0, text: '' };
let trendLoaded = false, trendRefreshing = false;
function loadTrendCacheOnce() {
  if (trendLoaded) return; trendLoaded = true;
  try { const j = JSON.parse(fs.readFileSync(TREND_FILE, 'utf8')); if (j && typeof j.text === 'string') trendCache = j; } catch (e) {}
}
function persistTrendCache() { try { fs.writeFileSync(TREND_FILE, JSON.stringify(trendCache)); } catch (e) {} }

function tavilySearch(query) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      api_key: CFG.tavilyKey, query,
      search_depth: 'advanced', topic: 'general',
      include_answer: 'advanced', max_results: 6,
    });
    const req = https.request({
      method: 'POST', hostname: 'api.tavily.com', path: '/search', port: 443,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }, timeout: 20000,
    }, res => {
      let body = ''; res.on('data', d => body += d);
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) return reject(new Error('tavily HTTP ' + res.statusCode + ': ' + body.slice(0, 200)));
        try { resolve(JSON.parse(body)); } catch (e) { reject(new Error('tavily bad json')); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('tavily timeout')));
    req.on('error', reject);
    req.write(payload); req.end();
  });
}
function trendQuery() {
  const d = new Date();
  const tpl = NICHE.trendQuery || 'Instagram Reels trends and content about {niche} {month} {year}: popular video formats, viral topics and hashtags';
  return tpl
    .replace(/\{month\}/g, RU_MONTHS[d.getMonth()])
    .replace(/\{year\}/g, String(d.getFullYear()))
    .replace(/\{niche\}/g, NICHE.niche || 'lifestyle');
}
async function refreshTrends() {
  const r = await tavilySearch(trendQuery());
  let text = (r && r.answer ? r.answer.trim() : '');
  if (r && Array.isArray(r.results)) {
    const heads = r.results.slice(0, 4).map(x => '• ' + (x.title || '').trim()).filter(s => s.length > 2);
    if (heads.length) text += (text ? '\n' : '') + 'Из свежих источников:\n' + heads.join('\n');
  }
  if (text) { trendCache = { ts: Date.now(), text: text.slice(0, 1200) }; persistTrendCache(); }
  return trendCache.text;
}
async function getTrendDigest() {
  loadTrendCacheOnce();
  const now = Date.now();
  if (CFG.tavilyKey && (!trendCache.ts || now - trendCache.ts > TREND_TTL_MS)) {
    if (trendCache.text) {
      if (!trendRefreshing) { trendRefreshing = true; refreshTrends().catch(()=>{}).finally(()=>{ trendRefreshing = false; }); }
    } else {
      try { await refreshTrends(); } catch (e) { console.error('[tavily]', e.message); }
    }
  }
  let out = 'Сегодня ' + todayStr() + '. Сезон: ' + seasonContext();
  if (trendCache.text) out += '\nАктуальные тренды ниши (из свежего поиска, опирайся на них):\n' + trendCache.text;
  return out;
}

/* ---------- prompts ---------- */
function profileBlock(profile) {
  profile = profile || {};
  return [
    'Профиль блогера (используй тон и нишу, не копируй дословно):',
    'Позиционирование: ' + (profile.positioning || '—'),
    'Имя/поиск: ' + (profile.name || '—'),
    'Шапка: ' + (profile.bio || '—'),
    'Голос блога: ' + (profile.tone || NICHE.tone || '—'),
    'Рубрики-актуальное: ' + (profile.highlights || '—'),
    'Ниша блога: ' + (NICHE.niche || '—'),
    'Аудитория: ' + (NICHE.audience || '—'),
  ].join('\n');
}
const TONE_RULES = [
  'Пиши строго на «ты», неформально. НИКОГДА не используй «Вы/Ваш/Ваши/Вам». Глаголы — в единственном числе («помни», «смотри», «попробуй»), не во множественном.',
  'Запрещены AI-штампы: «В современном мире», «Давайте разберёмся», «В этой статье», «играет важную роль», «не секрет, что».',
  'Будь конкретной: называй конкретные предметы/процессы из ниши, известные бренды/магазины, числа, сроки. Никакой воды и общих фраз.',
];

/* /api/generate */
function buildIdeaMessages(profile, rubric, trends, recent, prefRubric) {
  const sys = [
    'Ты — контент-стратег Instagram для русскоязычного блога по теме «' + (NICHE.niche || 'ниша') + '».',
    'Аудитория: ' + (NICHE.audience || 'обычные читатели'),
    ...TONE_RULES,
    '',
    'Главная цель — ОХВАТЫ и НОВЫЕ зрители. Механики алгоритма 2025–2026:',
    '- Reels несут к не-подписчикам сильнее всего → по умолчанию формат "Reels" (карусель — для гайда/чек-листа на сохранения).',
    '- Главные сигналы: репосты в личку (sends) и watch time. CTA провоцирует отправить другу/сохранить.',
    '- Первые 3 секунды решают (50% уходят) → hook цепляет мгновенно.',
    '- Удержание: открытая петля, «жди до конца», счётчик пунктов, быстрые склейки, до/после.',
    '',
    'Верни СТРОГО один JSON-объект (без markdown) со ВСЕМИ непустыми полями:',
    '{"rubric": один из [' + VALID_RUBRICS.join(', ') + '],',
    ' "format": один из [' + VALID_FORMATS.join(', ') + '],',
    ' "title", "hook", "shoot", "retention", "cta", "why",',
    ' "viral": массив из ["reach","saves","engagement"] (1-2 шт)}',
    'Поле "shoot" — обязательно опиши, что конкретно снять/показать по шагам.',
  ].join('\n');

  const parts = [profileBlock(profile), '', trends, ''];
  if (rubric && VALID_RUBRICS.includes(rubric)) {
    parts.push('Придумай ОДНУ свежую идею в рубрике "' + rubric + '" под цель: охваты.');
  } else {
    parts.push('Придумай ОДНУ свежую идею под цель: охваты.');
    if (prefRubric) parts.push('Желательно рубрика "' + prefRubric + '" (но если тренд диктует другое — выбери лучшее).');
  }
  if (Array.isArray(recent) && recent.length) {
    parts.push('НЕ повторяй и не перефразируй эти недавние идеи (придумай заметно другое — другая тема/угол/формат):');
    parts.push(recent.slice(0, 8).map(t => '— ' + String(t).slice(0, 90)).join('\n'));
  }
  parts.push('Привяжи идею к сезону/тренду выше, где уместно. Будь конкретной. Ответь только JSON.');
  parts.push('(вариативность: ' + Math.random().toString(36).slice(2, 8) + ')');

  return [{ role: 'system', content: sys }, { role: 'user', content: parts.join('\n') }];
}
function normalizeIdea(raw) {
  const o = (raw && typeof raw === 'object') ? raw : {};
  let rubric = String(o.rubric || '').trim(); if (!VALID_RUBRICS.includes(rubric)) rubric = VALID_RUBRICS[0] || 'general';
  let format = String(o.format || '').trim(); if (!VALID_FORMATS.includes(format)) format = 'Reels';
  let viral = Array.isArray(o.viral) ? o.viral.filter(x => ['reach','saves','engagement'].includes(x)) : [];
  if (!viral.length) viral = ['reach'];
  const str = x => (typeof x === 'string' ? x.trim() : '');
  const title = str(o.title) || 'Идея для Reels';
  return { rubric, format, title,
    hook: str(o.hook), shoot: str(o.shoot) || ('Сними процесс по теме «' + title + '»: крупные планы, до/после, быстрые склейки.'),
    retention: str(o.retention), cta: str(o.cta), why: str(o.why), viral };
}

/* /api/agent — SMM/UGC */
const clean = s => String(s == null ? '' : s).slice(0, 1500);
const AGENT_PERSONA = {
  smm: 'Ты — опытный SMM-менеджер Instagram-блога по теме «' + (NICHE.niche || 'ниша') + '». Думаешь про охваты, вовлечение и системность.',
  ugc: 'Ты — UGC-креатор и продюсер коротких видео для брендов в нише «' + (NICHE.niche || 'ниша') + '». Помогаешь блогеру зарабатывать на UGC.',
};
const AGENT_ACTIONS = {
  'smm.captions': { agent: 'smm', useTrends: true, build: (p, i) =>
`Напиши подписи (caption) к посту в Instagram.
Тема/идея поста: ${clean(i.topic) || '—'}
Формат: ${clean(i.format) || 'Reels'}

Дай РОВНО 3 варианта подписи в тоне блогера:
1) короткая и цепкая, 2) с пользой/конкретным советом, 3) с лёгким юмором/личным.
Каждая: 1–4 строки, эмодзи в меру, в конце CTA (сохрани / отправь другу / напиши в комменты).
В конце — раздел "## Хэштеги" и 15–18 русских хэштегов (микс нишевых и широких) одной строкой через пробел.` },

  'smm.plan': { agent: 'smm', useTrends: true, build: (p, i) =>
`Составь контент-план на неделю (7 дней) для блога. Учитывай сезон и тренды выше.
Акцент недели: ${clean(i.focus) || 'микс (польза + охваты + вовлечение)'}

Для каждого дня (Пн–Вс) строкой: **День** — формат (Reels/Карусель/Stories/Пост) · тема · короткий хук · лучшее время постинга.
Больше Reels на охваты, 1–2 карусели на сохранения, Stories на вовлечение. В конце — 1 совет недели.` },

  'smm.adapt': { agent: 'smm', useTrends: false, build: (p, i) =>
`Адаптируй пост из Instagram под другие площадки.
Исходный текст:
"""${clean(i.text) || '—'}"""

## Telegram — пост в тоне канала (можно длиннее, без хэштег-простыни, 1 ссылка-призыв).
## ВКонтакте — версия под VK (дружелюбно, 3–5 хэштегов VK).
## Идея Stories — 2–3 активности (опрос/вопрос/тест) по теме.
Смысл сохрани, но перепиши под каждую площадку.` },

  'smm.stories': { agent: 'smm', useTrends: true, build: (p, i) =>
`Придумай Stories-активности на неделю для вовлечения и удержания. Учитывай сезон/тренды выше.
Тема/повод недели: ${clean(i.theme) || 'свободная'}

6–8 идей. Каждая: **тип** (опрос / тест / вопрос-бокс / «этот или этот» / закулисье / голосование) — что показать и какой вопрос задать.
Цель — реакции и ответы в директ. Коротко.` },

  'ugc.script': { agent: 'ugc', useTrends: true, build: (p, i) =>
`Напиши UGC-сценарий короткого видео для бренда (нативно, как обычный пользователь). Учитывай тренды/сезон выше.
Товар: ${clean(i.product) || '—'}
Категория: ${clean(i.category) || 'товар из ниши'}
Длина: ${clean(i.length) || '30'} сек

## Хук (0–3 сек) — дословно что сказать/показать.
## Тело — проблема → как товар решает (по шагам).
## CTA — нативный призыв.
## Раскадровка — СПИСКОМ (без таблиц): «**0–3 сек** — что в кадре, крупность, что происходит».
## Текст под озвучку — 30–50 слов, разговорно.
Тон — живой, честный, как настоящий отзыв. Без рекламного пафоса.` },

  'ugc.pitch': { agent: 'ugc', useTrends: false, build: (p, i) =>
`Напиши короткое питч-письмо бренду для UGC-сотрудничества.
Бренд/магазин: ${clean(i.brand) || '—'}
Товар/ниша: ${clean(i.product) || 'товары из моей ниши'}

До ~150 слов: цепляющее первое предложение → кто я (UGC-видео для брендов из ниши) → чем полезна им → что предлагаю (1–2 тестовых видео) → мягкий призыв.
Дай 2 варианта: для Direct/мессенджера (короче) и для email (с темой письма).` },

  'ugc.ideas': { agent: 'ugc', useTrends: true, build: (p, i) =>
`Дай 5–7 идей UGC-видео под категорию товара для брендов в нише. Учитывай актуальные форматы/тренды выше.
Категория: ${clean(i.category) || 'товар'}

Каждая идея: **формат** (распаковка / до-после / обзор-результат / реакция / сравнение) — короткий хук + что показать. Форматы, которые легко снять дома. Коротко.` },

  'ugc.mediakit': { agent: 'ugc', useTrends: false, build: (p, i) =>
`Составь одностраничный медиа-кит UGC-креатора (для брендов).
Цена за 1 видео: ${clean(i.price) || 'указать диапазон'}
Контакт: ${clean(i.contact) || '—'}
Опыт/особенности: ${clean(i.experience) || 'начинающий UGC-креатор в своей нише'}

## Обо мне (1–2 предложения, ниша)
## Что снимаю (форматы UGC)
## Пакеты и цены (1 видео / 3 видео / месяц)
## Сроки и условия
## Контакты
Тон — уверенный, тёплый, без воды.` },
};
function buildAgentMessages(action, profile, input, trends) {
  const a = AGENT_ACTIONS[action];
  if (!a) return null;
  const sys = [
    AGENT_PERSONA[a.agent],
    'Аудитория блога: ' + (NICHE.audience || 'обычные читатели'),
    ...TONE_RULES,
    'Отвечай на русском в Markdown: ## подзаголовки, - списки, **жирный**. Без вступлений и воды — сразу польза.',
    'НЕ используй markdown-таблицы (символы | и |---|) — только списки и абзацы: таблицы ломаются на телефоне.',
  ].join('\n');
  const userParts = [profileBlock(profile)];
  if (a.useTrends && trends) userParts.push('', trends);
  userParts.push('', a.build(profile, input || {}));
  return [{ role: 'system', content: sys }, { role: 'user', content: userParts.join('\n') }];
}

/* ---------- DeepSeek ---------- */
function callDeepSeek(messages, opts) {
  opts = opts || {};
  return new Promise((resolve, reject) => {
    const reqBody = { model: CFG.model, messages, temperature: opts.temp != null ? opts.temp : 0.9, max_tokens: opts.maxTokens || 700 };
    if (opts.json !== false) reqBody.response_format = { type: 'json_object' };
    const payload = JSON.stringify(reqBody);
    const u = new URL(CFG.baseUrl.replace(/\/+$/, '') + '/v1/chat/completions');
    const req = https.request({
      method: 'POST', hostname: u.hostname, path: u.pathname, port: u.port || 443,
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + CFG.apiKey, 'Content-Length': Buffer.byteLength(payload) },
      timeout: 45000,
    }, res => {
      let body = ''; res.on('data', d => body += d);
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) return reject(new Error('deepseek HTTP ' + res.statusCode + ': ' + body.slice(0, 300)));
        try { resolve(JSON.parse(body)); } catch (e) { reject(new Error('deepseek bad json')); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('deepseek timeout')));
    req.on('error', reject);
    req.write(payload); req.end();
  });
}

/* ---------- HTTP ---------- */
function send(res, code, obj, origin) {
  const data = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': origin || CFG.allowedOrigin,
    'Access-Control-Allow-Headers': 'Content-Type, X-Uprava-Token',
    'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Vary': 'Origin',
  });
  res.end(data);
}
function readBody(req, cb) {
  let body = '', tooBig = false;
  req.on('data', d => { body += d; if (body.length > 16384) { tooBig = true; req.destroy(); } });
  req.on('end', () => { if (!tooBig) cb(body); });
}

const server = http.createServer((req, res) => {
  const origin = req.headers.origin;
  const okOrigin = !origin || CFG.allowedOrigin === '*' || origin === CFG.allowedOrigin;
  const corsOrigin = okOrigin ? (origin || CFG.allowedOrigin) : CFG.allowedOrigin;

  if (req.method === 'OPTIONS') return send(res, 204, {}, corsOrigin);

  if (req.method === 'GET' && (req.url === '/api/health' || req.url === '/health')) {
    rollDay(); loadTrendCacheOnce();
    return send(res, 200, { ok: true, niche: NICHE.name || 'default', model: CFG.model,
      spentUsd: +spend.usd.toFixed(4), capUsd: CFG.dailyCapUsd,
      trends: { enabled: !!CFG.tavilyKey, hasCache: !!trendCache.text, ageHours: trendCache.ts ? +((Date.now() - trendCache.ts) / 3.6e6).toFixed(1) : null }
    }, corsOrigin);
  }

  const isGenerate = req.method === 'POST' && req.url.startsWith('/api/generate');
  const isAgent = req.method === 'POST' && req.url.startsWith('/api/agent');
  if (!isGenerate && !isAgent) return send(res, 404, { error: 'not_found' }, corsOrigin);

  if (origin && !okOrigin) return send(res, 403, { error: 'forbidden_origin' }, corsOrigin);
  if (CFG.sharedToken && req.headers['x-uprava-token'] !== CFG.sharedToken) return send(res, 403, { error: 'forbidden' }, corsOrigin);
  const ip = (req.headers['x-real-ip'] || (req.headers['x-forwarded-for'] || '').split(',')[0] || req.socket.remoteAddress || '').trim();
  if (rateLimited(ip)) return send(res, 429, { error: 'rate_limited', message: 'Слишком часто. Подожди минутку.' }, corsOrigin);
  rollDay();
  if (spend.usd >= CFG.dailyCapUsd) return send(res, 429, { error: 'daily_cap', message: 'Лимит на сегодня исчерпан.' }, corsOrigin);
  if (!CFG.apiKey) return send(res, 500, { error: 'no_api_key' }, corsOrigin);

  readBody(req, async (body) => {
    let input = {};
    try { input = body ? JSON.parse(body) : {}; } catch (e) { return send(res, 400, { error: 'bad_json' }, corsOrigin); }
    const profile = (input.profile && typeof input.profile === 'object') ? input.profile : {};
    try {
      const trends = await getTrendDigest();
      if (isGenerate) {
        const rubric = typeof input.rubric === 'string' ? input.rubric : null;
        const recent = Array.isArray(input.recent) ? input.recent : [];
        const prefRubric = rubric ? null : VALID_RUBRICS[Math.floor(Math.random() * VALID_RUBRICS.length)];
        const resp = await callDeepSeek(buildIdeaMessages(profile, rubric, trends, recent, prefRubric), { json: true, maxTokens: 750, temp: 1.05 });
        const content = resp && resp.choices && resp.choices[0] && resp.choices[0].message && resp.choices[0].message.content;
        let parsed; try { parsed = JSON.parse(content); } catch (e) { return send(res, 502, { error: 'ai_bad_output' }, corsOrigin); }
        chargeUsage(resp.usage);
        return send(res, 200, normalizeIdea(parsed), corsOrigin);
      }
      const action = typeof input.action === 'string' ? input.action : '';
      if (!AGENT_ACTIONS[action]) return send(res, 400, { error: 'bad_action' }, corsOrigin);
      const messages = buildAgentMessages(action, profile, input.input || {}, trends);
      const resp = await callDeepSeek(messages, { json: false, maxTokens: 1500, temp: 0.85 });
      const content = resp && resp.choices && resp.choices[0] && resp.choices[0].message && resp.choices[0].message.content;
      if (!content) return send(res, 502, { error: 'ai_bad_output' }, corsOrigin);
      chargeUsage(resp.usage);
      return send(res, 200, { action, text: content.trim() }, corsOrigin);
    } catch (e) {
      console.error('[' + (isGenerate ? 'generate' : 'agent') + ']', e.message);
      return send(res, 502, { error: 'ai_unavailable', message: 'AI временно недоступен.' }, corsOrigin);
    }
  });
});

server.listen(CFG.port, '127.0.0.1', () => {
  console.log('niche-blog-toolkit backend on 127.0.0.1:' + CFG.port +
    ' · niche: ' + (NICHE.name || 'default') + ' · model: ' + CFG.model +
    ' · cap: $' + CFG.dailyCapUsd + ' · tavily: ' + (CFG.tavilyKey ? 'on' : 'off'));
});
