#!/usr/bin/env node
'use strict';
/*
 * Generate seed-ideas.json for a niche using DeepSeek (+ optional Tavily trends).
 * Reads the example's niche.json, batches by rubric, dedupes, writes seed-ideas.json.
 *
 *   node scripts/seed-ideas.js examples/fitness  --count=30
 *   node scripts/seed-ideas.js examples/plants   --count=150
 *
 * Requires .env in backend/ (DEEPSEEK_API_KEY required, TAVILY_API_KEY optional).
 */
const https = require('https');
const fs = require('fs');
const path = require('path');

const argv = process.argv.slice(2);
const positional = argv.filter(a => !a.startsWith('--'));
const flags = Object.fromEntries(argv.filter(a => a.startsWith('--'))
  .map(a => { const [k, v] = a.replace(/^--/, '').split('='); return [k, v == null ? true : v]; }));

if (!positional[0]) {
  console.error('usage: seed-ideas.js <example-dir>  [--count=30]');
  process.exit(1);
}

const ROOT = path.resolve(__dirname, '..');
const exampleDir = path.resolve(positional[0]);
const cfg = JSON.parse(fs.readFileSync(path.join(exampleDir, 'niche.json'), 'utf8'));
const TARGET = parseInt(flags.count || '30', 10);

/* env */
(function loadEnv(){
  const p = path.join(ROOT, 'backend', '.env');
  try {
    fs.readFileSync(p, 'utf8').split('\n').forEach(line => {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].trim();
    });
  } catch (e) {}
})();
const KEY = process.env.DEEPSEEK_API_KEY, BASE = process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com';
const MODEL = process.env.MODEL || 'deepseek-chat', TKEY = process.env.TAVILY_API_KEY;
if (!KEY) { console.error('DEEPSEEK_API_KEY not set in backend/.env'); process.exit(1); }

const RU_MONTHS = ['января','февраля','марта','апреля','мая','июня','июля','августа','сентября','октября','ноября','декабря'];
const VALID_FORMATS = ['Reels','Карусель','Пост','Stories'];

function post(host, p, headers, payload) {
  return new Promise((res, rej) => {
    const r = https.request({ method: 'POST', hostname: host, path: p, port: 443, headers, timeout: 60000 }, x => {
      let b = ''; x.on('data', d => b += d);
      x.on('end', () => (x.statusCode >= 200 && x.statusCode < 300) ? res(b) : rej(new Error(host + ' HTTP ' + x.statusCode + ': ' + b.slice(0, 200))));
    });
    r.on('timeout', () => r.destroy(new Error(host + ' timeout')));
    r.on('error', rej); r.write(payload); r.end();
  });
}
async function tavily() {
  if (!TKEY) return '';
  const d = new Date();
  const tpl = cfg.trendQuery || 'Instagram Reels trends about {niche} {month} {year}';
  const q = tpl.replace(/\{month\}/g, RU_MONTHS[d.getMonth()]).replace(/\{year\}/g, String(d.getFullYear())).replace(/\{niche\}/g, cfg.niche || 'lifestyle');
  try {
    const r = JSON.parse(await post('api.tavily.com', '/search',
      { 'Content-Type': 'application/json' },
      JSON.stringify({ api_key: TKEY, query: q, search_depth: 'advanced', include_answer: 'advanced', max_results: 6 })));
    let t = (r.answer || '').trim();
    if (Array.isArray(r.results)) t += '\nИсточники: ' + r.results.slice(0, 4).map(x => (x.title || '').trim()).join(' · ');
    return t.slice(0, 1200);
  } catch (e) { console.error('  tavily err', e.message); return ''; }
}
async function ds(messages, maxTokens) {
  const body = JSON.stringify({ model: MODEL, messages, temperature: 0.95, max_tokens: maxTokens || 4200, response_format: { type: 'json_object' } });
  const raw = await post(new URL(BASE).hostname, '/v1/chat/completions',
    { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + KEY, 'Content-Length': Buffer.byteLength(body) }, body);
  return JSON.parse(raw).choices[0].message.content;
}
const norm = s => String(s || '').toLowerCase().replace(/[^a-zа-яё0-9]+/gi, '');
function seasonHint() {
  const m = new Date().getMonth();
  if (m >= 2 && m <= 4)  return 'весна';
  if (m >= 5 && m <= 7)  return 'лето';
  if (m >= 8 && m <= 10) return 'осень';
  return 'зима';
}

(async () => {
  const trends = await tavily();
  console.error('Trends:', trends ? trends.length + ' chars' : 'none');

  const rubrics = cfg.rubrics || [];
  const PER = Math.ceil(TARGET / rubrics.length) + 1;
  const sys = [
    'Ты — контент-стратег Instagram для русскоязычного блога по теме «' + (cfg.niche || 'ниша') + '».',
    'Аудитория: ' + (cfg.audience || 'обычные читатели'),
    'Тон: ' + (cfg.tone || 'дружелюбный, простыми словами'),
    'Пиши строго на «ты», глаголы — в ед. числе. Без AI-штампов.',
    'Будь конкретной: называй известные предметы/процессы/бренды из ниши, числа, сроки.',
    'Цель — охваты: Reels-first, сильный хук в первые 3 сек, CTA на сохранение/репост.',
    'НЕ используй markdown-таблицы. Отвечай строго JSON.',
  ].join('\n');

  const seen = new Set();
  const out = [];
  const dateStr = new Date().getDate() + ' ' + RU_MONTHS[new Date().getMonth()] + ' ' + new Date().getFullYear();

  for (const r of rubrics) {
    if (out.length >= TARGET) break;
    const avoid = out.slice(-30).map(o => o.t);
    const user = [
      'Сегодня ' + dateStr + '. Сезон: ' + seasonHint() + '.',
      trends ? ('Тренды ниши:\n' + trends) : '',
      '',
      'Придумай ' + PER + ' РАЗНЫХ идей в рубрике «' + r.name + '» (' + r.id + ') под цель охваты.',
      'Каждая — отдельная тема/угол, не повторяй и не перефразируй друг друга' + (avoid.length ? ' и этот список:\n' + avoid.map(t => '— ' + t).join('\n') : '.'),
      '',
      'Верни СТРОГО JSON: {"ideas":[{"f":"Reels|Карусель|Пост|Stories","t":"заголовок до ~60 симв","hook":"первые 3 сек","shoot":"что снять","ret":"приём удержания","cta":"призыв","why":"почему зайдёт","v":["reach"|"saves"|"engagement"]}]}',
      'Поля непустые.',
    ].join('\n');
    try {
      const content = await ds([{ role: 'system', content: sys }, { role: 'user', content: user }]);
      const ideas = (JSON.parse(content).ideas || []);
      let added = 0;
      for (const it of ideas) {
        const t = (it.t || '').trim(); if (!t) continue;
        const k = norm(t); if (seen.has(k)) continue; seen.add(k);
        out.push({
          r: r.id,
          f: VALID_FORMATS.includes(it.f) ? it.f : 'Reels',
          t, hook: it.hook || '', shoot: it.shoot || '', ret: it.ret || '',
          cta: it.cta || '', why: it.why || '',
          v: Array.isArray(it.v) ? it.v.filter(x => ['reach','saves','engagement'].includes(x)) : ['reach'],
        });
        if (!out[out.length - 1].v.length) out[out.length - 1].v = ['reach'];
        added++;
      }
      console.error('  [' + r.id + '] +' + added + ' (total ' + out.length + ')');
    } catch (e) {
      console.error('  [' + r.id + '] ERROR:', e.message);
    }
  }

  const trimmed = out.slice(0, TARGET);
  const dst = path.join(exampleDir, 'seed-ideas.json');
  fs.writeFileSync(dst, JSON.stringify(trimmed, null, 2));
  console.error('✓ Wrote', trimmed.length, 'ideas to', path.relative(process.cwd(), dst));
})();
