#!/usr/bin/env node
'use strict';
/*
 * Render frontend/index.template.html into a deploy-ready frontend/dist/index.html
 * using a niche config (and optional seed-ideas.json).
 *
 *   node scripts/apply-niche.js examples/plants
 *   node scripts/apply-niche.js examples/fitness  --token=my-secret
 *
 * Output: frontend/dist/index.html  (single-file static, ready to scp anywhere).
 */
const fs = require('fs');
const path = require('path');

const argv = process.argv.slice(2);
const positional = argv.filter(a => !a.startsWith('--'));
const flags = Object.fromEntries(argv.filter(a => a.startsWith('--')).map(a => {
  const [k, v] = a.replace(/^--/, '').split('='); return [k, v == null ? true : v];
}));

if (!positional[0]) {
  console.error('usage: apply-niche.js <example-dir>  [--token=X] [--out=path]');
  console.error('example: apply-niche.js examples/plants --token=secret');
  process.exit(1);
}

const ROOT = path.resolve(__dirname, '..');
const exampleDir = path.resolve(positional[0]);
const cfgPath = path.join(exampleDir, 'niche.json');
const seedPath = path.join(exampleDir, 'seed-ideas.json');
const tplPath = path.join(ROOT, 'frontend', 'index.template.html');
const outPath = flags.out ? path.resolve(flags.out) : path.join(ROOT, 'frontend', 'dist', 'index.html');

const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
const seed = fs.existsSync(seedPath) ? JSON.parse(fs.readFileSync(seedPath, 'utf8')) : [];
let tpl = fs.readFileSync(tplPath, 'utf8');

/* Build RUBRICS JS literal (id-keyed objects) — matches the upstream shape */
const rubricsJs = JSON.stringify(cfg.rubrics || [], null, 2);
/* Build SEED JS literal — pre-sized for readability but compact enough */
const seedJs = JSON.stringify(seed, null, 1);

/* Escape for embedding inside <textarea>...</textarea> */
const escTa = s => String(s == null ? '' : s)
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;');

const colors = Object.assign({
  primary: '#3f7d52', primaryDark: '#2f5d3d', accent: '#c98a3b', bg: '#f4f7f2'
}, cfg.colors || {});

const subs = {
  '{{TITLE}}':            cfg.title || 'Niche Blog Toolkit',
  '{{SUBTITLE}}':         cfg.subtitle || 'Идеи и инструменты для нишевого блога',
  '{{EMOJI}}':            cfg.emoji || '✨',
  '{{BRAND_HANDLE}}':     cfg.brand || '@your_blog',
  '{{SHARED_TOKEN}}':     flags.token || cfg.sharedToken || 'change-me-in-prod',
  '{{NICHE_NAME}}':       (cfg.name || 'default').replace(/[^a-z0-9_]/gi, '_').toLowerCase(),
  '{{COLOR_BG}}':         colors.bg,
  '{{COLOR_PRIMARY}}':    colors.primary,
  '{{COLOR_PRIMARY_DARK}}': colors.primaryDark,
  '{{COLOR_ACCENT}}':     colors.accent,
  '{{PACK_POSITIONING}}': escTa((cfg.packaging || {}).positioning),
  '{{PACK_NAME}}':        escTa((cfg.packaging || {}).name),
  '{{PACK_BIO_RU}}':      escTa((cfg.packaging || {}).bio_ru),
  '{{PACK_BIO_EN}}':      escTa((cfg.packaging || {}).bio_en),
  '{{PACK_LINK}}':        escTa((cfg.packaging || {}).link),
  '{{PACK_HIGHLIGHTS}}':  escTa((cfg.packaging || {}).highlights),
  '{{PACK_PINNED}}':      escTa((cfg.packaging || {}).pinned),
  '{{PACK_VISUAL}}':      escTa((cfg.packaging || {}).visual),
  '{{PACK_AVATAR}}':      escTa((cfg.packaging || {}).avatar),
  '{{PACK_TONE}}':        escTa((cfg.packaging || {}).tone),
};

for (const [marker, value] of Object.entries(subs)) {
  tpl = tpl.split(marker).join(value);
}
tpl = tpl.replace('/*__RUBRICS__*/[]', rubricsJs);
tpl = tpl.replace('/*__SEED__*/[]', seedJs);

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, tpl);

console.log('✓ Rendered:', path.relative(process.cwd(), outPath));
console.log('  niche:', cfg.name, '· rubrics:', (cfg.rubrics || []).length, '· seed ideas:', seed.length, '· size:', (tpl.length / 1024).toFixed(0) + ' KB');
const leftover = tpl.match(/\{\{[A-Z_]+\}\}/g);
if (leftover) console.warn('  ⚠ unreplaced markers:', [...new Set(leftover)].join(', '));
