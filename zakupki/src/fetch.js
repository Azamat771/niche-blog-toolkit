'use strict';
/**
 * Загрузка архивов открытых данных ЕИС по FTP.
 *
 * Важно: структура каталогов на ftp.zakupki.gov.ru менялась между редакциями,
 * поэтому пути не зашиты жёстко. Клиент обходит дерево и сам ищет каталог
 * региона и подкаталоги с извещениями/протоколами/отменами. Если обход
 * не сработал — есть команда `explore`, чтобы посмотреть реальное дерево
 * глазами, и режим `--source=dir` для архивов, скачанных любым другим способом.
 */

const fs = require('fs');
const path = require('path');
const { FtpClient } = require('./ftp');

const DEFAULT_HOST = 'ftp.zakupki.gov.ru';
const DEFAULT_USER = 'free';
const DEFAULT_PASSWORD = 'free';

/** Корни, с которых имеет смысл начинать поиск. Проверяются по очереди. */
const ROOT_CANDIDATES = {
  44: ['/fcs_regions', '/fcs_nsi', '/'],
  223: ['/out/published', '/223fz', '/'],
};

const DOC_DIR_PATTERNS = {
  notification: /notification|notice|invitation/i,
  protocol: /protocol/i,
  cancel: /cancel|annul/i,
};

/** Грубая транслитерация для сопоставления «Оренбургская» с «Orenburgskaja». */
const TRANSLIT = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z',
  и: 'i', й: 'j', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r',
  с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'c', ч: 'ch', ш: 'sh', щ: 'sch',
  ъ: '', ы: 'y', ь: '', э: 'e', ю: 'ju', я: 'ja',
};

function translit(text) {
  return String(text)
    .toLowerCase()
    .split('')
    .map((ch) => (TRANSLIT[ch] !== undefined ? TRANSLIT[ch] : ch))
    .join('')
    .replace(/[^a-z0-9]/g, '');
}

/**
 * Приводит название региона к корню: и «Оренбургская область», и
 * «Orenburgskaja_obl», и «Orenburgskaya_obl» должны дать «orenburg».
 *
 * ЕИС транслитерирует «я» то как ja, то как ya, поэтому сначала сводим
 * j к y, а затем последовательно срезаем суффиксы — их может быть несколько
 * подряд («…skaya» + «obl»).
 */
const REGION_SUFFIXES = /(skaya|skoy|oblast|obl|kray|respublika|resp|avtonomnyy|ao)$/;

function regionStem(text) {
  let stem = translit(text).replace(/j/g, 'y');
  for (let i = 0; i < 4; i += 1) {
    const trimmed = stem.replace(REGION_SUFFIXES, '');
    if (trimmed === stem || trimmed.length < 3) break;
    stem = trimmed;
  }
  return stem;
}

/** Совпадает ли имя каталога с искомым регионом. */
function matchesRegion(dirName, regionQuery) {
  if (!regionQuery) return false;
  const dir = regionStem(dirName);
  const query = regionStem(regionQuery);
  if (query.length < 3) return false;
  return dir === query || dir.startsWith(query) || query.startsWith(dir);
}

/** Достаёт год и месяц из пути архива: ..._20240101_20240201_001.xml.zip */
function pathPeriod(fullPath) {
  const dates = [...String(fullPath).matchAll(/(20\d{2})(\d{2})(\d{2})/g)];
  if (dates.length) {
    return { year: Number(dates[0][1]), month: Number(dates[0][2]) };
  }
  const ym = /(?:^|[^0-9])(20\d{2})[-_/]?(0[1-9]|1[0-2])(?:[^0-9]|$)/.exec(String(fullPath));
  if (ym) return { year: Number(ym[1]), month: Number(ym[2]) };
  const year = /(?:^|[^0-9])(20\d{2})(?:[^0-9]|$)/.exec(String(fullPath));
  if (year) return { year: Number(year[1]), month: null };
  return { year: null, month: null };
}

function inPeriod(period, from, to) {
  if (period.year === null) return true; // currMonth/prevMonth — берём, отфильтруем при разборе
  const value = period.year * 100 + (period.month || 1);
  return value >= from && value <= to;
}

function parseMonthArg(text, fallback) {
  if (!text) return fallback;
  const m = /^(\d{4})-(\d{2})$/.exec(String(text).trim());
  if (!m) throw new Error(`период должен быть в формате YYYY-MM, получено: ${text}`);
  return Number(m[1]) * 100 + Number(m[2]);
}

/**
 * Рекурсивный обход дерева FTP с ограничением глубины.
 * @returns {Promise<Array<{path: string, isDirectory: boolean, size: number}>>}
 */
async function crawl(client, root, opts = {}) {
  const maxDepth = opts.maxDepth ?? 3;
  const shouldEnter = opts.shouldEnter || (() => true);
  const onEntry = opts.onEntry || (() => {});
  const results = [];

  async function visit(dir, depth) {
    let entries;
    try {
      entries = await client.list(dir);
    } catch (err) {
      if (opts.verbose) console.error(`  ! не прочитан ${dir}: ${err.message}`);
      return;
    }
    for (const entry of entries) {
      const full = dir === '/' ? `/${entry.name}` : `${dir}/${entry.name}`;
      const item = { path: full, name: entry.name, isDirectory: entry.isDirectory, size: entry.size };
      results.push(item);
      onEntry(item, depth);
      if (entry.isDirectory && depth < maxDepth && shouldEnter(item, depth)) {
        await visit(full, depth + 1);
      }
    }
  }

  await visit(root, 0);
  return results;
}

async function connect(opts = {}) {
  const client = new FtpClient({
    host: opts.host || DEFAULT_HOST,
    port: opts.port || 21,
    user: opts.user || DEFAULT_USER,
    password: opts.password || DEFAULT_PASSWORD,
    secure: !!opts.secure,
    verbose: !!opts.verbose,
    timeout: opts.timeout || 60000,
  });
  await client.connect();
  return client;
}

/** Печатает дерево каталогов — чтобы увидеть реальную структуру сервера. */
async function explore(opts) {
  const client = await connect(opts);
  try {
    const roots = opts.root ? [opts.root] : ROOT_CANDIDATES[opts.law || 44];
    for (const root of roots) {
      console.log(`\n=== ${root}`);
      let printed = 0;
      await crawl(client, root, {
        maxDepth: opts.depth ?? 2,
        verbose: opts.verbose,
        shouldEnter: (item) => !opts.region || matchesRegion(item.name, opts.region),
        onEntry: (item, depth) => {
          if (printed >= (opts.limit ?? 200)) return;
          printed += 1;
          console.log(`${'  '.repeat(depth)}${item.isDirectory ? '📁' : '  '} ${item.name}${item.isDirectory ? '' : ` (${item.size} б)`}`);
        },
      });
      if (printed) break; // корень найден, дальше искать не нужно
    }
  } finally {
    await client.close();
  }
}

/**
 * Скачивает архивы за период в локальный каталог.
 * @returns {Promise<{downloaded: number, skipped: number, bytes: number, files: string[]}>}
 */
async function fetchArchives(opts) {
  const from = parseMonthArg(opts.from, 200001);
  const to = parseMonthArg(opts.to, 999912);
  const outDir = opts.outDir;
  fs.mkdirSync(outDir, { recursive: true });

  const client = await connect(opts);
  const summary = { downloaded: 0, skipped: 0, bytes: 0, files: [] };

  try {
    const roots = opts.root ? [opts.root] : ROOT_CANDIDATES[opts.law || 44];
    let regionRoot = null;

    for (const root of roots) {
      let entries;
      try {
        entries = await client.list(root);
      } catch {
        continue;
      }
      const hit = entries.find((e) => e.isDirectory && matchesRegion(e.name, opts.region));
      if (hit) {
        regionRoot = root === '/' ? `/${hit.name}` : `${root}/${hit.name}`;
        console.log(`Каталог региона: ${regionRoot}`);
        break;
      }
    }

    if (!regionRoot) {
      throw new Error(
        `не найден каталог региона «${opts.region}» в ${roots.join(', ')}. ` +
        'Посмотрите реальное дерево: node zakupki/cli.js explore --law=' + (opts.law || 44)
      );
    }

    const wantedKinds = opts.kinds || ['notification', 'protocol', 'cancel'];
    const archives = [];

    await crawl(client, regionRoot, {
      maxDepth: opts.depth ?? 3,
      verbose: opts.verbose,
      shouldEnter: (item, depth) => {
        // на первом уровне заходим только в интересующие типы документов
        if (depth === 0) {
          return wantedKinds.some((kind) => DOC_DIR_PATTERNS[kind].test(item.name));
        }
        return true;
      },
      onEntry: (item) => {
        if (item.isDirectory || !/\.zip$/i.test(item.name)) return;
        if (!inPeriod(pathPeriod(item.path), from, to)) return;
        archives.push(item);
      },
    });

    console.log(`Найдено архивов за период: ${archives.length}`);

    for (const archive of archives) {
      const localName = archive.path.replace(/^\//, '').replace(/\//g, '__');
      const target = path.join(outDir, localName);
      if (fs.existsSync(target) && fs.statSync(target).size === archive.size && archive.size > 0) {
        summary.skipped += 1;
        continue;
      }
      process.stdout.write(`↓ ${archive.name} … `);
      try {
        const data = await client.download(archive.path);
        fs.writeFileSync(target, data);
        summary.downloaded += 1;
        summary.bytes += data.length;
        summary.files.push(target);
        console.log(`${(data.length / 1048576).toFixed(1)} МБ`);
      } catch (err) {
        console.log(`ошибка: ${err.message}`);
      }
    }
  } finally {
    await client.close();
  }

  return summary;
}

module.exports = {
  explore,
  fetchArchives,
  crawl,
  connect,
  matchesRegion,
  regionStem,
  translit,
  pathPeriod,
  inPeriod,
  parseMonthArg,
  ROOT_CANDIDATES,
  DEFAULT_HOST,
};
