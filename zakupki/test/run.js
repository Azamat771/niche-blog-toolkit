'use strict';
/**
 * Офлайн-тесты всей цепочки: XML → ZIP → извлечение → классификация →
 * склейка переобъявлений → аналитика → отчёт.
 *
 * Запуск: node zakupki/cli.js selftest
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { parseXml, pickText, pickFirstGroup, deepText } = require('../src/xml');
const { iterateFiles, listEntries } = require('../src/zip');
const { classifyDocument, reduceOutcomes, OUTCOME } = require('../src/classify');
const { extractRecord, detectLaw, detectDocumentKind, toDate, toNumber } = require('../src/extract');
const { classifyNiche } = require('../src/taxonomy');
const { clusterRepublications, tokenize, jaccard } = require('../src/cluster');
const { analyze } = require('../src/analyze');
const { buildMarkdown, buildCsvs } = require('../src/report');
const { parseListLine } = require('../src/ftp');
const { matchesRegion, pathPeriod, inPeriod, parseMonthArg } = require('../src/fetch');
const { ingestDirectory } = require('../src/ingest');
const { makeZip, notificationXml, protocolXml, cancelXml } = require('./helpers');

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed += 1;
    failures.push({ name, err });
    console.log(`  ✗ ${name}`);
    console.log(`      ${err.message}`);
  }
}

function group(title) {
  console.log(`\n${title}`);
}

// ---------------------------------------------------------------- XML

group('XML-парсер');

test('разбирает вложенность, атрибуты и пространства имён', () => {
  const root = parseXml(
    '<ns2:export xmlns:ns2="http://x"><a id="7"><b>текст</b></a></ns2:export>'
  );
  const exportNode = root.children[0];
  assert.strictEqual(exportNode.name, 'export');
  assert.strictEqual(exportNode.children[0].name, 'a');
  assert.strictEqual(exportNode.children[0].attrs.id, '7');
  assert.strictEqual(deepText(exportNode), 'текст');
});

test('понимает CDATA, сущности и самозакрывающиеся теги', () => {
  const root = parseXml('<r><a><![CDATA[<сырьё>]]></a><b>1 &amp; 2 &#1073;</b><c/></r>');
  assert.strictEqual(deepText(root.children[0].children[0]), '<сырьё>');
  assert.strictEqual(deepText(root.children[0].children[1]), '1 & 2 б');
  assert.strictEqual(root.children[0].children[2].name, 'c');
});

test('не разваливается на незакрытом теге', () => {
  const root = parseXml('<r><a><b>x</a><c>y</c></r>');
  assert.ok(deepText(root).includes('x'));
  assert.ok(deepText(root).includes('y'));
});

test('pickFirstGroup берёт один тег, а не смесь тегов', () => {
  const root = parseXml('<r><lot><maxPrice>100</maxPrice></lot><lot><maxPrice>300</maxPrice></lot><sum>999999</sum></r>');
  const values = pickFirstGroup(root, ['maxPrice', 'sum']);
  assert.deepStrictEqual(values, ['100', '300']);
});

// ---------------------------------------------------------------- ZIP

group('ZIP-ридер');

test('читает deflate и stored в одном архиве', () => {
  const zip = makeZip([
    { name: 'a.xml', data: '<r>сжатый</r>' },
    { name: 'b.xml', data: '<r>несжатый</r>', store: true },
  ]);
  const files = [...iterateFiles(zip, (n) => n.endsWith('.xml'))];
  assert.strictEqual(files.length, 2);
  assert.strictEqual(files[0].data.toString('utf8'), '<r>сжатый</r>');
  assert.strictEqual(files[1].data.toString('utf8'), '<r>несжатый</r>');
});

test('фильтр отсекает лишние файлы', () => {
  const zip = makeZip([
    { name: 'doc.xml', data: '<r/>' },
    { name: 'readme.txt', data: 'привет' },
  ]);
  assert.strictEqual([...iterateFiles(zip, (n) => /\.xml$/.test(n))].length, 1);
  assert.strictEqual(listEntries(zip).length, 2);
});

test('сообщает понятную ошибку, если это не ZIP', () => {
  assert.throws(() => listEntries(Buffer.from('не архив')), /не ZIP-архив|End of Central/);
});

// ---------------------------------------------------------------- классификация

group('Классификация исходов');

const cases = [
  ['не подано ни одной заявки на участие', OUTCOME.NO_BIDS],
  ['По окончании срока подачи заявок не поступило ни одной заявки', OUTCOME.NO_BIDS],
  ['Аукцион признан несостоявшимся: отсутствие поданных заявок', OUTCOME.NO_BIDS],
  ['подана только одна заявка на участие в закупке', OUTCOME.SINGLE_BID],
  ['Все заявки на участие отклонены комиссией', OUTCOME.ALL_REJECTED],
  ['Победителем аукциона признан участник №2', OUTCOME.COMPLETED],
  ['Об отмене извещения о проведении закупки', OUTCOME.CANCELLED],
  ['Закупка признана несостоявшейся', OUTCOME.FAILED_OTHER],
];

for (const [text, expected] of cases) {
  test(`«${text.slice(0, 45)}…» → ${expected}`, () => {
    const verdict = classifyDocument({ text, tags: [], values: [] });
    assert.strictEqual(verdict.outcome, expected);
    assert.ok(verdict.evidence.length > 0, 'должно остаться доказательство');
  });
}

test('«нет заявок» приоритетнее общего «несостоявшаяся»', () => {
  const verdict = classifyDocument({
    text: 'Аукцион признан несостоявшимся, так как не подано ни одной заявки',
    tags: [],
  });
  assert.strictEqual(verdict.outcome, OUTCOME.NO_BIDS);
});

test('несколько документов сводятся к самому конкретному исходу', () => {
  const reduced = reduceOutcomes([
    { outcome: OUTCOME.FAILED_OTHER, priority: 60, evidence: [] },
    { outcome: OUTCOME.NO_BIDS, priority: 100, evidence: [] },
  ]);
  assert.strictEqual(reduced.outcome, OUTCOME.NO_BIDS);
});

test('отмена без протоколов по существу остаётся отменой', () => {
  const reduced = reduceOutcomes([{ outcome: OUTCOME.CANCELLED, priority: 70, evidence: [] }]);
  assert.strictEqual(reduced.outcome, OUTCOME.CANCELLED);
});

// ---------------------------------------------------------------- извлечение

group('Извлечение полей');

test('вытаскивает поля извещения', () => {
  const xml = notificationXml({
    number: '0153300012124000123',
    object: 'Поставка канцелярских товаров',
    customer: 'МБОУ СОШ №1 г. Орска',
    inn: '5613001234',
    price: '187500.00',
    date: '2024-03-14',
    okpd: '17.23.13',
  });
  const record = extractRecord(xml, 'notification_123.xml', 'fz44/archive.zip');
  assert.strictEqual(record.kind, 'notification');
  assert.strictEqual(record.purchaseNumber, '0153300012124000123');
  assert.strictEqual(record.purchaseObject, 'Поставка канцелярских товаров');
  assert.strictEqual(record.customerName, 'МБОУ СОШ №1 г. Орска');
  assert.strictEqual(record.customerInn, '5613001234');
  assert.strictEqual(record.maxPrice, 187500);
  assert.strictEqual(record.publishDate, '2024-03-14');
  assert.deepStrictEqual(record.okpd, ['17.23.13']);
  assert.strictEqual(record.law, 44);
});

test('НМЦК берётся из лота, а не из суммы плана', () => {
  const xml = notificationXml({
    number: '0153300012124000124',
    object: 'Поставка бумаги',
    customer: 'МБОУ СОШ №2',
    inn: '5613001235',
    price: '95000',
    date: '2024-04-01',
    okpd: '17.12.14',
    extraSum: '48000000', // общий лимит плана-графика — не должен попасть в НМЦК
  });
  const record = extractRecord(xml, 'notification_124.xml', 'fz44/a.zip');
  assert.strictEqual(record.maxPrice, 95000);
});

test('протокол распознаётся и получает исход', () => {
  const xml = protocolXml({ number: '0153300012124000123', date: '2024-03-26', kind: 'NO_BIDS' });
  const record = extractRecord(xml, 'protocol_123.xml', 'fz44/a.zip');
  assert.strictEqual(record.kind, 'protocol');
  assert.strictEqual(record.outcome, OUTCOME.NO_BIDS);
});

test('отмена распознаётся раньше, чем извещение', () => {
  const xml = cancelXml({ number: '0153300012124000123', date: '2024-04-02' });
  const record = extractRecord(xml, 'notificationCancel_123.xml', 'fz44/a.zip');
  assert.strictEqual(record.kind, 'cancel');
  assert.strictEqual(record.outcome, OUTCOME.CANCELLED);
});

test('223 в номере закупки не переводит её в 223-ФЗ', () => {
  assert.strictEqual(detectLaw('notification_0122300000223000456.xml', 'fz44/a.zip'), 44);
  assert.strictEqual(detectLaw('notice.xml', 'fz223/a.zip'), 223);
  assert.strictEqual(detectLaw('notice.xml', 'a.zip', 'http://zakupki.gov.ru/223fz/types/1'), 223);
});

test('тип документа определяется по тегам и имени файла', () => {
  assert.strictEqual(detectDocumentKind('x.xml', ['fcsProtocolEF']), 'protocol');
  assert.strictEqual(detectDocumentKind('x.xml', ['fcsNotificationCancel']), 'cancel');
  assert.strictEqual(detectDocumentKind('x.xml', ['fcsNotificationEF']), 'notification');
  assert.strictEqual(detectDocumentKind('contract_1.xml', ['contract']), 'contract');
});

test('даты и числа приводятся к единому виду', () => {
  assert.strictEqual(toDate('2024-03-14T09:00:00+05:00'), '2024-03-14');
  assert.strictEqual(toDate('14.03.2024'), '2024-03-14');
  assert.strictEqual(toDate('ерунда'), null);
  assert.strictEqual(toNumber('187 500,50'), 187500.5);
  assert.strictEqual(toNumber(''), null);
});

// ---------------------------------------------------------------- ниши

group('Таксономия ниш');

test('ОКПД2 определяет раздел', () => {
  const niche = classifyNiche({ okpd: ['43.21.10'], purchaseObject: '' });
  assert.strictEqual(niche.source, 'okpd');
  assert.strictEqual(niche.label, 'Специализированные строительные работы');
});

test('без ОКПД2 работает разбор по названию', () => {
  const niche = classifyNiche({ okpd: [], purchaseObject: 'Оказание услуг по уборке помещений' });
  assert.strictEqual(niche.source, 'keyword');
  assert.strictEqual(niche.label, 'Клининг и уборка');
});

test('нераспознанное честно помечается', () => {
  const niche = classifyNiche({ okpd: [], purchaseObject: 'Нечто невнятное' });
  assert.strictEqual(niche.key, 'UNCLASSIFIED');
});

// ---------------------------------------------------------------- переобъявления

group('Переобъявления');

test('похожие названия одного заказчика сходятся в цепочку', () => {
  const purchases = [
    { purchaseNumber: '1', customerInn: '5613001234', purchaseObject: 'Поставка канцелярских товаров для нужд школы', publishDate: '2024-02-01' },
    { purchaseNumber: '2', customerInn: '5613001234', purchaseObject: 'Поставка канцелярских товаров', publishDate: '2024-04-01' },
    { purchaseNumber: '3', customerInn: '5613001234', purchaseObject: 'Поставка канцелярских товаров 2024', publishDate: '2024-06-01' },
  ];
  const clusters = clusterRepublications(purchases);
  assert.strictEqual(clusters.length, 1);
  assert.strictEqual(clusters[0].attemptCount, 3);
});

test('разные предметы одного заказчика не склеиваются', () => {
  const purchases = [
    { purchaseNumber: '1', customerInn: '5613001234', purchaseObject: 'Поставка канцелярских товаров', publishDate: '2024-02-01' },
    { purchaseNumber: '2', customerInn: '5613001234', purchaseObject: 'Капитальный ремонт кровли спортивного зала', publishDate: '2024-03-01' },
  ];
  assert.strictEqual(clusterRepublications(purchases).length, 2);
});

test('одинаковые закупки разных заказчиков не склеиваются', () => {
  const purchases = [
    { purchaseNumber: '1', customerInn: '111', purchaseObject: 'Поставка канцелярских товаров', publishDate: '2024-02-01' },
    { purchaseNumber: '2', customerInn: '222', purchaseObject: 'Поставка канцелярских товаров', publishDate: '2024-03-01' },
  ];
  assert.strictEqual(clusterRepublications(purchases).length, 2);
});

test('слишком далёкие по времени попытки — разные цепочки', () => {
  const purchases = [
    { purchaseNumber: '1', customerInn: '111', purchaseObject: 'Поставка канцелярских товаров', publishDate: '2021-02-01' },
    { purchaseNumber: '2', customerInn: '111', purchaseObject: 'Поставка канцелярских товаров', publishDate: '2026-02-01' },
  ];
  assert.strictEqual(clusterRepublications(purchases, { maxGapDays: 550 }).length, 2);
});

test('токенизация выбрасывает шум и годы', () => {
  const tokens = tokenize('Поставка канцелярских товаров для нужд учреждения в 2024 году');
  assert.ok(tokens.includes('канцелярских'));
  assert.ok(!tokens.includes('поставка'));
  assert.ok(!tokens.some((t) => /2024/.test(t)));
  assert.strictEqual(jaccard(new Set(['a', 'b']), new Set(['a', 'b'])), 1);
});

// ---------------------------------------------------------------- FTP / загрузка

group('FTP и обход дерева');

test('разбирает unix- и dos-листинг', () => {
  const unix = parseListLine('drwxr-xr-x 2 owner group 4096 Aug 16 20:54 notifications');
  assert.strictEqual(unix.name, 'notifications');
  assert.strictEqual(unix.isDirectory, true);

  const file = parseListLine('-rw-r--r-- 1 owner group 10485760 Aug 16 20:54 notification_2024.zip');
  assert.strictEqual(file.name, 'notification_2024.zip');
  assert.strictEqual(file.isDirectory, false);
  assert.strictEqual(file.size, 10485760);

  const dos = parseListLine('08-16-26  09:41PM       <DIR>          protocols');
  assert.strictEqual(dos.name, 'protocols');
  assert.strictEqual(dos.isDirectory, true);
});

test('регион находится по русскому названию в латинском каталоге', () => {
  assert.ok(matchesRegion('Orenburgskaja_obl', 'Оренбургская'));
  assert.ok(matchesRegion('Orenburgskaya_obl', 'Оренбургская область'));
  assert.ok(!matchesRegion('Omskaja_obl', 'Оренбургская'));
});

test('период вычисляется из имени архива', () => {
  assert.deepStrictEqual(
    pathPeriod('/fcs_regions/Orenburgskaja_obl/notifications/notification_20240301_20240401_001.xml.zip'),
    { year: 2024, month: 3 }
  );
  assert.strictEqual(pathPeriod('/x/currMonth/file.zip').year, null);
  assert.ok(inPeriod({ year: null, month: null }, 202101, 202608), 'без даты архив берём');
  assert.ok(!inPeriod({ year: 2019, month: 5 }, 202101, 202608));
  assert.strictEqual(parseMonthArg('2024-03', 0), 202403);
  assert.throws(() => parseMonthArg('март', 0), /YYYY-MM/);
});

// ---------------------------------------------------------------- сквозной прогон

group('Сквозной прогон: архивы → отчёт');

/** Синтетический массив: 2022–2026, три ниши, разная конкурентность. */
function buildDataset() {
  const docs = [];
  let seq = 0;
  const nextNumber = () => `01533000121${String(24000000 + (seq += 1)).padStart(9, '0')}`;

  const add = (name, xml) => docs.push({ name, data: xml });

  // Ниша А: клининг — стабильно никто не заходит, заказчик переобъявляет
  for (const year of [2022, 2023, 2024, 2025, 2026]) {
    let previousFailed = 0;
    for (const month of ['02', '04']) {
      if (year === 2026 && month === '04') continue; // текущий год ещё не закончился
      const number = nextNumber();
      add(`notification_${number}.xml`, notificationXml({
        number,
        object: 'Оказание услуг по уборке помещений образовательного учреждения',
        customer: 'МБОУ СОШ №1 г. Орска',
        inn: '5613001234',
        price: '340000',
        date: `${year}-${month}-10`,
        okpd: '81.21.10',
      }));
      add(`protocol_${number}.xml`, protocolXml({
        number,
        date: `${year}-${month}-25`,
        kind: 'NO_BIDS',
      }));
      previousFailed += 1;
    }
    assert.ok(previousFailed > 0);
  }

  // Ниша Б: канцтовары — конкурентная, закупки состоятся
  for (const year of [2022, 2023, 2024, 2025, 2026]) {
    for (const month of ['03', '09']) {
      if (year === 2026 && month === '09') continue;
      const number = nextNumber();
      add(`notification_${number}.xml`, notificationXml({
        number,
        object: 'Поставка канцелярских товаров',
        customer: 'ГБУЗ Городская больница г. Оренбурга',
        inn: '5610009999',
        price: '120000',
        date: `${year}-${month}-05`,
        okpd: '17.23.13',
      }));
      add(`protocol_${number}.xml`, protocolXml({
        number,
        date: `${year}-${month}-20`,
        kind: 'COMPLETED',
      }));
    }
  }

  // Ниша В: ремонт — часть отменяется
  for (const year of [2023, 2024, 2025]) {
    const number = nextNumber();
    add(`notification_${number}.xml`, notificationXml({
      number,
      object: 'Текущий ремонт кровли здания администрации',
      customer: 'Администрация Сакмарского района',
      inn: '5642000111',
      price: '580000',
      date: `${year}-05-12`,
      okpd: '43.99.90',
    }));
    add(`notificationCancel_${number}.xml`, cancelXml({ number, date: `${year}-05-28` }));
  }

  // Закупка вне бюджета — должна отсеяться
  const big = nextNumber();
  add(`notification_${big}.xml`, notificationXml({
    number: big,
    object: 'Строительство спортивного комплекса',
    customer: 'Администрация Сакмарского района',
    inn: '5642000111',
    price: '48000000',
    date: '2025-06-01',
    okpd: '41.20.10',
  }));
  add(`protocol_${big}.xml`, protocolXml({ number: big, date: '2025-06-20', kind: 'NO_BIDS' }));

  return docs;
}

let endToEnd = null;

test('архивы разбираются в записи', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zakupki-test-'));
  const fz44 = path.join(tmp, 'fz44');
  fs.mkdirSync(fz44, { recursive: true });
  fs.writeFileSync(path.join(fz44, 'orenburg_2022_2026.zip'), makeZip(buildDataset()));

  const { records, stats } = ingestDirectory(tmp);
  assert.strictEqual(stats.archives, 1);
  assert.strictEqual(stats.failedDocuments, 0);
  assert.ok(records.length > 30, `записей мало: ${records.length}`);
  assert.ok(records.every((r) => r.law === 44));

  endToEnd = { tmp, records };
});

test('анализ считает динамику и отбирает по бюджету', () => {
  const result = analyze(endToEnd.records, {
    budgetMax: 600000,
    currentDate: '2026-08-16',
    laws: [44, 223],
    minCount: 3,
  });

  assert.strictEqual(result.meta.currentYear, 2026);
  assert.strictEqual(result.meta.cutoffMonth, 8);
  // закупка на 48 млн не должна пройти бюджетный фильтр
  assert.strictEqual(result.meta.inScope - result.meta.inBudget, 1);
  assert.ok(!result.purchases.some((p) => p.maxPrice === 48000000));

  // все закупки получили распознанный исход
  assert.strictEqual(result.meta.unknownOutcome, 0);

  const years = result.dynamics.full.map((y) => y.year);
  assert.deepStrictEqual(years, [2022, 2023, 2024, 2025, 2026]);

  endToEnd.result = result;
});

test('YTD-срез сравнивает одинаковые окна года', () => {
  const { dynamics } = endToEnd.result;
  const ytd2025 = dynamics.ytd.find((y) => y.year === 2025);
  const full2025 = dynamics.full.find((y) => y.year === 2025);
  // за янв–авг попадает меньше закупок, чем за весь 2025 (сентябрьские отсекаются)
  assert.ok(ytd2025.total < full2025.total, 'YTD должен быть уже полного года');
  assert.ok(ytd2025.total > 0);
});

test('клининг поднимается выше канцтоваров в рейтинге ниш', () => {
  const niches = endToEnd.result.niches.filter((n) => n.enoughData);
  const cleaning = niches.find((n) => /Обслуживание зданий/.test(n.label));
  const office = niches.find((n) => /Бумага/.test(n.label));
  assert.ok(cleaning, 'ниша клининга не найдена');
  assert.ok(office, 'ниша канцтоваров не найдена');
  assert.strictEqual(cleaning.zeroBidRate, 1);
  assert.strictEqual(office.zeroBidRate, 0);
  assert.ok(cleaning.score > office.score, `${cleaning.score} должен быть больше ${office.score}`);
});

test('переобъявления и точки входа находятся', () => {
  const { clusters, opportunities } = endToEnd.result;
  assert.ok(clusters.length > 0, 'цепочки переобъявлений не найдены');

  const cleaning = opportunities.find((o) => /уборк/i.test(o.title));
  assert.ok(cleaning, 'точка входа по клинингу не найдена');
  assert.ok(cleaning.failedAttempts >= 2, `провалов должно быть больше: ${cleaning.failedAttempts}`);
  assert.strictEqual(cleaning.lastOutcome, 'NO_BIDS');
  assert.ok(cleaning.url.includes(cleaning.lastPurchaseNumber));

  // отменённая закупка не должна попасть в точки входа
  assert.ok(!opportunities.some((o) => /кровли/i.test(o.title)));
});

test('отчёт и CSV собираются', () => {
  const result = endToEnd.result;
  result.meta.region = 'Оренбургская область';
  const markdown = buildMarkdown(result);

  for (const heading of ['Что вошло в расчёт', 'Динамика по годам', 'Ниши: где никто не заходит',
    'Конкретные точки входа', 'Методика и ограничения']) {
    assert.ok(markdown.includes(heading), `в отчёте нет раздела «${heading}»`);
  }
  assert.ok(markdown.includes('Оренбургская область'));
  assert.ok(/янв–авг/.test(markdown), 'нет пометки об окне сравнения');

  const csvs = buildCsvs(result);
  assert.ok(csvs.niches.startsWith('﻿'), 'нет BOM для Excel');
  assert.ok(csvs.opportunities.split('\n').length > 1);
  assert.ok(csvs.purchases.includes('Доказательство'));

  // точка с запятой как разделитель и экранирование кавычек
  assert.ok(csvs.niches.split('\n')[0].includes(';'));

  fs.rmSync(endToEnd.tmp, { recursive: true, force: true });
});

// ---------------------------------------------------------------- итог

function run() {
  console.log(`\n${'─'.repeat(50)}`);
  console.log(`Пройдено: ${passed}, провалено: ${failed}`);
  if (failed) {
    console.log('\nПровалы:');
    for (const f of failures) {
      console.log(`  ${f.name}`);
      console.log(`    ${f.err.stack.split('\n').slice(0, 3).join('\n    ')}`);
    }
    process.exitCode = 1;
  } else {
    console.log('Все тесты зелёные.');
  }
}

module.exports = run;

if (require.main === module) run();
