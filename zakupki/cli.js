#!/usr/bin/env node
'use strict';
/**
 * CLI анализа несостоявшихся и отменённых госзакупок.
 *
 *   node zakupki/cli.js explore  --region=Оренбургская --law=44
 *   node zakupki/cli.js fetch    --region=Оренбургская --from=2021-01 --to=2026-08 --law=44
 *   node zakupki/cli.js analyze  --budget-max=600000
 *   node zakupki/cli.js selftest
 */

const fs = require('fs');
const path = require('path');

const { explore, fetchArchives } = require('./src/fetch');
const { ingestDirectory, saveRecords, loadRecords } = require('./src/ingest');
const { analyze } = require('./src/analyze');
const { buildMarkdown, buildCsvs } = require('./src/report');

const NETWORK_ERRORS = ['ENOTFOUND', 'ECONNREFUSED', 'ETIMEDOUT', 'ECONNRESET', 'EHOSTUNREACH'];

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const OUT_DIR = path.join(ROOT, 'out');
const RECORDS_FILE = path.join(DATA_DIR, 'records.jsonl');

function parseArgs(argv) {
  const args = { _: [] };
  for (const token of argv) {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(token);
    if (m) args[m[1]] = m[2] === undefined ? true : m[2];
    else args._.push(token);
  }
  return args;
}

function num(value, fallback) {
  if (value === undefined || value === true) return fallback;
  const n = Number(String(value).replace(/[\s_]/g, ''));
  return Number.isFinite(n) ? n : fallback;
}

function laws(args) {
  if (!args.law) return [44, 223];
  return String(args.law)
    .split(',')
    .map((l) => Number(l.trim()))
    .filter((l) => l === 44 || l === 223);
}

const COMMANDS = {
  async explore(args) {
    await explore({
      region: args.region,
      law: laws(args)[0],
      root: args.root,
      depth: num(args.depth, 2),
      limit: num(args.limit, 200),
      secure: !!args.secure,
      verbose: !!args.verbose,
      host: args.host,
    });
  },

  async fetch(args) {
    if (!args.region) throw new Error('укажите регион: --region=Оренбургская');
    const targets = laws(args);
    for (const law of targets) {
      console.log(`\n### ${law}-ФЗ`);
      const summary = await fetchArchives({
        region: args.region,
        law,
        from: args.from,
        to: args.to,
        root: args.root,
        depth: num(args.depth, 3),
        outDir: path.join(DATA_DIR, `fz${law}`),
        secure: !!args.secure,
        verbose: !!args.verbose,
        host: args.host,
      });
      console.log(
        `Готово: скачано ${summary.downloaded}, пропущено ${summary.skipped}, ` +
        `${(summary.bytes / 1048576).toFixed(1)} МБ`
      );
    }
  },

  async parse(args) {
    const dir = args.dir ? path.resolve(args.dir) : DATA_DIR;
    console.log(`Разбираю архивы из ${dir} …`);
    const { records, stats } = ingestDirectory(dir, {
      onProgress: (done, total, name) => {
        if (done % 10 === 0 || done === total) {
          process.stdout.write(`\r  ${done}/${total} архивов (${name.slice(0, 50)})`);
        }
      },
    });
    process.stdout.write('\n');
    await saveRecords(records, RECORDS_FILE);
    console.log(
      `Архивов: ${stats.archives}, XML: ${stats.xmlFiles}, записей: ${stats.parsed}, ` +
      `пропущено: ${stats.skipped}, ошибок разбора: ${stats.failedDocuments}`
    );
    if (stats.failedArchives.length) {
      console.log(`Не прочитаны архивы: ${stats.failedArchives.length}`);
      for (const f of stats.failedArchives.slice(0, 5)) console.log(`  ${f.archive}: ${f.error}`);
    }
    console.log(`Записи сохранены: ${RECORDS_FILE}`);
    return records;
  },

  async analyze(args) {
    let records = loadRecords(RECORDS_FILE);
    if (!records.length) {
      console.log('Готовых записей нет — сначала разбираю архивы.');
      records = await COMMANDS.parse(args);
    }
    if (!records.length) {
      throw new Error(
        `нет данных. Скачайте архивы: node zakupki/cli.js fetch --region=... ` +
        `или положите ZIP-архивы в ${DATA_DIR} и запустите parse`
      );
    }

    const result = analyze(records, {
      budgetMax: num(args['budget-max'], 600000),
      budgetMin: num(args['budget-min'], 0),
      currentDate: args.date || new Date().toISOString().slice(0, 10),
      minCount: num(args['min-count'], 4),
      laws: laws(args),
      freshMonths: num(args['fresh-months'], 12),
    });
    result.meta.region = args.region || 'Оренбургская область';

    fs.mkdirSync(OUT_DIR, { recursive: true });
    const markdown = buildMarkdown(result);
    fs.writeFileSync(path.join(OUT_DIR, 'report.md'), markdown, 'utf8');

    const csvs = buildCsvs(result);
    fs.writeFileSync(path.join(OUT_DIR, 'niches.csv'), csvs.niches, 'utf8');
    fs.writeFileSync(path.join(OUT_DIR, 'opportunities.csv'), csvs.opportunities, 'utf8');
    fs.writeFileSync(path.join(OUT_DIR, 'purchases.csv'), csvs.purchases, 'utf8');

    console.log(`\nЗакупок в анализе: ${result.meta.inBudget}`);
    console.log(`Ниш определено: ${result.niches.length}`);
    console.log(`Цепочек переобъявлений: ${result.clusters.length}`);
    console.log(`Точек входа: ${result.opportunities.length}`);
    console.log(`\nОтчёт: ${path.join(OUT_DIR, 'report.md')}`);
    console.log(`Таблицы: ${OUT_DIR}/niches.csv, opportunities.csv, purchases.csv`);

    const top = result.niches.filter((n) => n.enoughData).slice(0, 5);
    if (top.length) {
      console.log('\nТоп ниш:');
      for (const [i, n] of top.entries()) {
        console.log(
          `  ${i + 1}. ${n.label} — score ${n.score}, без заявок ` +
          `${(n.zeroBidRate * 100).toFixed(0)}% (${n.noBids} из ${n.total})`
        );
      }
    }
  },

  async all(args) {
    await COMMANDS.fetch(args);
    await COMMANDS.parse(args);
    await COMMANDS.analyze(args);
  },

  /** Прогон на синтетических данных — проверить установку и увидеть формат отчёта. */
  async demo(args) {
    const { buildDemoArchive } = require('./test/demo-data');
    const demoDir = path.join(DATA_DIR, 'demo', 'fz44');
    fs.mkdirSync(demoDir, { recursive: true });

    const currentDate = args.date || '2026-08-16';
    const { zip, documents } = buildDemoArchive({ currentDate });
    fs.writeFileSync(path.join(demoDir, 'demo_2021_2026.zip'), zip);
    console.log(`Сгенерирован демо-архив: ${documents} документов`);

    const { records, stats } = ingestDirectory(path.join(DATA_DIR, 'demo'));
    console.log(`Разобрано записей: ${stats.parsed}`);

    const result = analyze(records, {
      budgetMax: num(args['budget-max'], 600000),
      currentDate,
      laws: [44, 223],
      minCount: num(args['min-count'], 4),
    });
    result.meta.region = 'ДЕМО (синтетические данные)';

    const outDir = path.join(OUT_DIR, 'demo');
    fs.mkdirSync(outDir, { recursive: true });
    const markdown = buildMarkdown(result);
    fs.writeFileSync(path.join(outDir, 'report.md'), markdown, 'utf8');
    const csvs = buildCsvs(result);
    for (const [name, content] of Object.entries(csvs)) {
      fs.writeFileSync(path.join(outDir, `${name}.csv`), content, 'utf8');
    }

    console.log(`\nЗакупок: ${result.meta.inBudget}, ниш: ${result.niches.length}, ` +
      `цепочек: ${result.clusters.length}, точек входа: ${result.opportunities.length}`);
    console.log(`Демо-отчёт: ${path.join(outDir, 'report.md')}`);
    console.log('\n⚠️  Данные синтетические. Для реального анализа: fetch → parse → analyze');
  },

  async selftest() {
    require('./test/run')();
  },
};

const HELP = `
Анализ несостоявшихся и отменённых закупок (44-ФЗ / 223-ФЗ)

Команды:
  explore   Показать дерево каталогов ЕИС (диагностика структуры FTP)
  fetch     Скачать архивы за период
  parse     Разобрать локальные архивы в записи
  analyze   Построить отчёт и CSV
  all       fetch + parse + analyze
  demo      Прогон на синтетических данных (проверка установки, пример отчёта)
  selftest  Прогнать офлайн-тесты на фикстурах

Параметры:
  --region=Оренбургская    регион (обязателен для fetch/explore)
  --law=44,223             какие законы (по умолчанию оба)
  --from=2021-01 --to=2026-08   период выгрузки
  --budget-max=600000      потолок НМЦК для анализа
  --budget-min=0           нижняя граница НМЦК
  --min-count=4            минимум закупок, чтобы ниша попала в рейтинг
  --fresh-months=12        глубина «свежих» точек входа
  --date=2026-08-16        дата расчёта (для сравнения YTD)
  --dir=path               каталог с архивами для parse
  --secure                 использовать FTPS
  --verbose                подробный лог

Примеры:
  node zakupki/cli.js fetch --region=Оренбургская --from=2021-01 --to=2026-08
  node zakupki/cli.js analyze --budget-max=600000
`;

async function main() {
  const argv = process.argv.slice(2);
  const args = parseArgs(argv);
  const command = args._[0];

  if (!command || args.help || command === 'help') {
    console.log(HELP);
    return;
  }
  if (!COMMANDS[command]) {
    console.error(`Неизвестная команда: ${command}`);
    console.log(HELP);
    process.exitCode = 1;
    return;
  }

  try {
    await COMMANDS[command](args);
  } catch (err) {
    console.error(`\nОшибка: ${err.message}`);
    if (NETWORK_ERRORS.includes(err.code) || /ENOTFOUND|ECONNREFUSED|ETIMEDOUT/.test(err.message)) {
      console.error(
        '\nПохоже, до ftp.zakupki.gov.ru нет доступа. Проверьте:\n' +
        '  • есть ли интернет и не блокирует ли FTP корпоративная сеть или VPN;\n' +
        '  • пробуйте FTPS: добавьте --secure;\n' +
        '  • сервер ЕИС периодически недоступен — повторите позже.\n' +
        'Загрузку можно обойти: скачайте архивы вручную и разберите их через\n' +
        '  node zakupki/cli.js parse --dir=<каталог с ZIP>'
      );
    }
    if (args.verbose) console.error(err.stack);
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = { parseArgs, COMMANDS };
