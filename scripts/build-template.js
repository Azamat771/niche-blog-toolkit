'use strict';
/*
 * One-time builder: takes the live ../../uprava-bloga/index.html (the upstream working
 * frontend), strips niche-specific data, injects placeholder markers, and writes
 * ../frontend/index.template.html — the canonical template of niche-blog-toolkit.
 *
 * After that, `scripts/apply-niche.js examples/<niche>` renders the template into a
 * deploy-ready frontend/dist/index.html.
 *
 * Run once when upstream index.html structure changes:
 *   node scripts/build-template.js
 */
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', '..', 'uprava-bloga', 'index.html');
const DST = path.join(__dirname, '..', 'frontend', 'index.template.html');

let html = fs.readFileSync(SRC, 'utf8');

/* ----- 1) Title, header, brand ----- */
html = html.replace(
  /<title>[^<]+<\/title>/,
  '<title>{{TITLE}} · {{SUBTITLE}}</title>'
);
html = html.replace(
  /<span class="leaf">🪴<\/span>\s*<div>\s*<h1>Управа блога<\/h1>\s*<div class="sub">Банк идей и рубрик для блога о растениях<\/div>/,
  '<span class="leaf">{{EMOJI}}</span>\n      <div>\n        <h1>{{TITLE}}</h1>\n        <div class="sub">{{SUBTITLE}}</div>'
);
html = html.replace(
  /<div class="acct">[^<]*<b id="acctName">[^<]+<\/b><\/div>/,
  '<div class="acct">📷 <b id="acctName">{{BRAND_HANDLE}}</b></div>'
);

/* ----- 2) AI token (was hardcoded "uprava_vika_7Qk2Zx") ----- */
html = html.replace(
  /const AI_TOKEN = "[^"]*";/,
  'const AI_TOKEN = "{{SHARED_TOKEN}}";'
);

/* ----- 3) Replace inline RUBRICS array with marker ----- */
{
  const rubStart = html.indexOf('const RUBRICS = [');
  if (rubStart < 0) throw new Error('RUBRICS not found');
  const rubEnd = html.indexOf('\n];', rubStart);
  if (rubEnd < 0) throw new Error('RUBRICS end not found');
  html = html.slice(0, rubStart) + 'const RUBRICS = /*__RUBRICS__*/[];' + html.slice(rubEnd + 3);
}

/* ----- 4) Replace inline SEED array with marker ----- */
{
  const seedStart = html.indexOf('const SEED = [');
  if (seedStart < 0) throw new Error('SEED not found');
  const seedEnd = html.indexOf('\n];', seedStart);
  if (seedEnd < 0) throw new Error('SEED end not found');
  html = html.slice(0, seedStart) + 'const SEED = /*__SEED__*/[];' + html.slice(seedEnd + 3);
}

/* ----- 5) Storage key — make it per-niche so different niches don't collide ----- */
html = html.replace(
  /const KEY = "vikablog_ideas_v1";/,
  'const KEY = "nbtk_{{NICHE_NAME}}_ideas_v1";'
);
html = html.replace(
  /const VKEY = "vikablog_seed_v";/,
  'const VKEY = "nbtk_{{NICHE_NAME}}_seed_v";'
);

/* ----- 6) Replace default texts in Packaging textareas with markers ----- */
function replaceTextarea(key, marker) {
  const re = new RegExp('(<textarea[^>]*data-save="' + key + '"[^>]*>)[\\s\\S]*?(<\\/textarea>)');
  if (!re.test(html)) console.warn('  textarea not found:', key);
  html = html.replace(re, '$1' + marker + '$2');
}
replaceTextarea('positioning', '{{PACK_POSITIONING}}');
replaceTextarea('name',        '{{PACK_NAME}}');
replaceTextarea('bio_ru',      '{{PACK_BIO_RU}}');
replaceTextarea('bio_en',      '{{PACK_BIO_EN}}');
replaceTextarea('link',        '{{PACK_LINK}}');
replaceTextarea('highlights',  '{{PACK_HIGHLIGHTS}}');
replaceTextarea('pinned',      '{{PACK_PINNED}}');
replaceTextarea('visual',      '{{PACK_VISUAL}}');
replaceTextarea('avatar',      '{{PACK_AVATAR}}');
replaceTextarea('tone',        '{{PACK_TONE}}');

/* ----- 7) Replace CSS palette in :root with markers ----- */
html = html.replace(/--bg:#f4f7f2;/,    '--bg:{{COLOR_BG}};');
html = html.replace(/--green:#3f7d52;/, '--green:{{COLOR_PRIMARY}};');
html = html.replace(/--green-dark:#2f5d3d;/, '--green-dark:{{COLOR_PRIMARY_DARK}};');
html = html.replace(/--accent:#c98a3b;/, '--accent:{{COLOR_ACCENT}};');

/* ----- 8) Footer note about author ----- */
html = html.replace(
  /Все идеи хранятся прямо в твоём браузере на этом устройстве\. Никуда не отправляются\.<br>\s*«✨ Свежая идея от AI» — единственная кнопка, которая отправляет на сервер только тексты твоей «Упаковки профиля», чтобы придумать идею\./,
  'Все идеи хранятся прямо в твоём браузере. Никуда не отправляются.<br>«✨ Свежая идея от AI» — единственная кнопка, которая отправляет на сервер только тексты «Упаковки профиля», чтобы придумать идею.<br><a href="https://github.com/your-handle/niche-blog-toolkit" target="_blank" rel="noopener" style="color:inherit;text-decoration:underline">Built with niche-blog-toolkit (MIT)</a>'
);

fs.writeFileSync(DST, html);
console.log('OK — template written to', path.relative(process.cwd(), DST));
console.log('   markers present:',
  ['{{TITLE}}','{{EMOJI}}','{{BRAND_HANDLE}}','{{SHARED_TOKEN}}','{{NICHE_NAME}}','/*__RUBRICS__*/','/*__SEED__*/','{{PACK_POSITIONING}}','{{COLOR_PRIMARY}}']
    .map(m => m + ':' + (html.includes(m) ? '✓' : '✗')).join(' '));
