'use strict';
/**
 * Сборка отчёта: markdown для чтения + CSV для Excel.
 */

const { OUTCOME_LABELS } = require('./classify');

const MONTHS = [
  'янв', 'фев', 'мар', 'апр', 'май', 'июн',
  'июл', 'авг', 'сен', 'окт', 'ноя', 'дек',
];

function money(value) {
  if (value === null || value === undefined) return '—';
  return new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 }).format(value);
}

function percent(value) {
  if (!Number.isFinite(value)) return '—';
  return `${(value * 100).toFixed(0)}%`;
}

function table(headers, rows) {
  const head = `| ${headers.join(' | ')} |`;
  const sep = `| ${headers.map(() => '---').join(' | ')} |`;
  const body = rows.map((r) => `| ${r.join(' | ')} |`).join('\n');
  return [head, sep, body].filter(Boolean).join('\n');
}

function buildMarkdown(result) {
  const { meta, dynamics, niches, opportunities, clusters } = result;
  const out = [];

  out.push('# Анализ несостоявшихся и отменённых закупок');
  out.push('');
  out.push(
    `**Регион:** ${meta.region || 'см. параметры запуска'} · ` +
    `**Законы:** ${meta.laws.map((l) => `${l}-ФЗ`).join(', ')} · ` +
    `**Бюджет:** до ${money(meta.budgetMax)} ₽ · ` +
    `**Дата расчёта:** ${meta.generatedFor}`
  );
  out.push('');

  // --- охват данных
  out.push('## 1. Что вошло в расчёт');
  out.push('');
  out.push(table(
    ['Показатель', 'Значение'],
    [
      ['Разобрано XML-документов', money(meta.totalRecords)],
      ['Уникальных закупок', money(meta.totalPurchases)],
      ['В выбранных законах', money(meta.inScope)],
      ['Попадает в бюджет', money(meta.inBudget)],
      ['Исход не определён', `${money(meta.unknownOutcome)} — по ним выводы не делались`],
      ['Протоколы без извещения', money(meta.orphanVerdicts)],
    ]
  ));
  out.push('');
  if (meta.unknownOutcome / Math.max(meta.inBudget, 1) > 0.3) {
    out.push(
      '> ⚠️ Более 30% закупок без распознанного исхода. Скорее всего, не выгружены ' +
      'протоколы за часть периода — доли «нет заявок» занижены. Догрузите протоколы ' +
      'и пересчитайте, прежде чем принимать решения.'
    );
    out.push('');
  }

  // --- динамика
  out.push('## 2. Динамика по годам');
  out.push('');
  out.push('Полные годы:');
  out.push('');
  out.push(table(
    ['Год', 'Закупок', 'Нет заявок', 'Доля', 'Один участник', 'Откл./иное', 'Отменено',
      'Состоялось', 'Исход неизвестен', 'Сумма НМЦК, ₽'],
    dynamics.full.map((y) => [
      y.year,
      money(y.total),
      money(y.noBids),
      percent(y.total ? y.noBids / y.total : 0),
      money(y.singleBid),
      money(y.allRejected),
      money(y.cancelled),
      money(y.completed),
      money(y.unknown),
      money(Math.round(y.sum)),
    ])
  ));
  out.push('');
  out.push(
    `Сравнение с текущим годом — по одинаковому окну (январь–${MONTHS[dynamics.cutoffMonth - 1]}), ` +
    'иначе неполный год всегда выглядит провалом:'
  );
  out.push('');
  out.push(table(
    ['Год (янв–' + MONTHS[dynamics.cutoffMonth - 1] + ')', 'Закупок', 'Нет заявок', 'Доля', 'Отменено'],
    dynamics.ytd.map((y) => [
      y.year === dynamics.currentYear ? `**${y.year}**` : y.year,
      money(y.total),
      money(y.noBids),
      percent(y.total ? y.noBids / y.total : 0),
      money(y.cancelled),
    ])
  ));
  out.push('');

  const current = dynamics.ytd.find((y) => y.year === dynamics.currentYear);
  const prior = dynamics.ytd.filter((y) => y.year < dynamics.currentYear);
  if (current && prior.length) {
    const avgTotal = prior.reduce((a, b) => a + b.total, 0) / prior.length;
    const avgRate = prior.reduce((a, b) => a + (b.total ? b.noBids / b.total : 0), 0) / prior.length;
    const rate = current.total ? current.noBids / current.total : 0;
    out.push(
      `**Вывод по текущему году:** объявлено ${money(current.total)} закупок против ` +
      `${money(Math.round(avgTotal))} в среднем за то же окно прошлых лет. ` +
      `Доля без заявок — ${percent(rate)} против ${percent(avgRate)} исторически ` +
      `(${rate > avgRate ? 'конкуренция падает, окно расширяется' : 'конкуренция растёт'}).`
    );
    out.push('');
  }

  // --- ниши
  out.push('## 3. Ниши: где никто не заходит');
  out.push('');
  out.push(
    'Score 0–100 складывается из доли закупок без заявок (35), упорства заказчиков — ' +
    'сколько раз переобъявляют (20), объёма (15), числа разных заказчиков (10), ' +
    'повторяемости по годам (10) и динамики текущего года (10).'
  );
  out.push('');
  const topNiches = niches.filter((n) => n.enoughData).slice(0, 20);
  out.push(table(
    ['#', 'Ниша', 'Score', 'Закупок', 'Нет заявок', 'Доля', 'Переобъявл.', 'Заказчиков', 'Средняя НМЦК, ₽', 'Пик месяцев'],
    topNiches.map((n, i) => [
      i + 1,
      n.label,
      n.score,
      money(n.total),
      money(n.noBids),
      percent(n.zeroBidRate),
      n.avgAttempts.toFixed(1),
      money(n.customers),
      money(n.avgPrice),
      n.seasonality.peaks.map((m) => MONTHS[m - 1]).join(', ') || '—',
    ])
  ));
  out.push('');

  const thin = niches.filter((n) => !n.enoughData && n.noBids > 0).slice(0, 10);
  if (thin.length) {
    out.push(
      `<details><summary>Ниши с малой выборкой (${thin.length}) — сигнал есть, статистики мало</summary>`
    );
    out.push('');
    out.push(table(
      ['Ниша', 'Закупок', 'Нет заявок'],
      thin.map((n) => [n.label, n.total, n.noBids])
    ));
    out.push('');
    out.push('</details>');
    out.push('');
  }

  // --- точки входа
  out.push('## 4. Конкретные точки входа');
  out.push('');
  out.push(
    'Цепочки, где последняя попытка провалилась из-за отсутствия заявок. ' +
    'Отсортировано по числу провалов: чем больше, тем сильнее заказчику нужен поставщик.'
  );
  out.push('');
  const topOpps = opportunities.slice(0, 40);
  if (topOpps.length) {
    out.push(table(
      ['Заказчик', 'Предмет', 'НМЦК, ₽', 'Попыток', 'Провалов', 'Посл. публикация', 'Обычные месяцы', 'ЕИС'],
      topOpps.map((o) => [
        (o.customerName || '—').slice(0, 60),
        (o.title || '—').slice(0, 80).replace(/\|/g, '/'),
        money(o.maxPrice),
        o.attemptCount,
        o.failedAttempts,
        o.lastPublishDate || '—',
        o.months.map((m) => MONTHS[m - 1]).join(', '),
        `[${o.lastPurchaseNumber}](${o.url})`,
      ])
    ));
  } else {
    out.push('_Не найдено. Проверьте, что выгружены протоколы, а не только извещения._');
  }
  out.push('');

  // --- упорные заказчики
  const persistent = clusters
    .slice()
    .sort((a, b) => b.attemptCount - a.attemptCount)
    .slice(0, 15);
  if (persistent.length) {
    out.push('## 5. Кто переобъявляет чаще всех');
    out.push('');
    out.push(table(
      ['Заказчик', 'Предмет', 'Попыток', 'Исходы'],
      persistent.map((c) => [
        (c.customerName || '—').slice(0, 60),
        (c.title || '—').slice(0, 70).replace(/\|/g, '/'),
        c.attemptCount,
        c.attempts.map((a) => OUTCOME_LABELS[a.outcome] || '?').join(' → '),
      ])
    ));
    out.push('');
  }

  // --- методика
  out.push('## 6. Методика и ограничения');
  out.push('');
  out.push('- Источник — открытые данные ЕИС (zakupki.gov.ru), XML в ZIP-архивах.');
  out.push('- Исход определяется маркерами в тексте и тегах протоколов, а не по XSD: схемы менялись между годами. Каждая запись хранит фрагмент-доказательство — их видно в `purchases.csv`.');
  out.push('- Переобъявления определяются по совпадению заказчика и схожести названия (Жаккар ≥ 0.6). Разные формулировки одной потребности могут не склеиться, а похожие разные — склеиться. Список цепочек стоит просматривать глазами.');
  out.push('- Закупки без НМЦК в бюджетный фильтр не отсекаются, чтобы не терять данные, — они попадают в общий свод.');
  out.push('- Отсутствие заявок в прошлом не гарантирует их отсутствия в следующий раз: часть ниш пустует из-за нерешаемых причин (нужна лицензия, СРО, реестр производителей, нереальные сроки). Перед подачей проверяйте требования документации.');
  out.push('');

  return out.join('\n');
}

function csvEscape(value) {
  const s = value === null || value === undefined ? '' : String(value);
  return /[";\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(headers, rows) {
  // разделитель ; и BOM — чтобы русский Excel открыл без плясок
  const lines = [headers.join(';')];
  for (const row of rows) lines.push(row.map(csvEscape).join(';'));
  return `﻿${lines.join('\n')}`;
}

function buildCsvs(result) {
  const niches = toCsv(
    ['Ниша', 'Ключ', 'Score', 'Закупок', 'Нет заявок', 'Доля без заявок', 'Один участник',
      'Отменено', 'Состоялось', 'Среднее число попыток', 'Заказчиков', 'Средняя НМЦК',
      'Сумма НМЦК', 'YTD текущий', 'YTD средний прошлый'],
    result.niches.map((n) => [
      n.label, n.key, n.score, n.total, n.noBids, (n.zeroBidRate * 100).toFixed(1),
      n.singleBid, n.cancelled, n.completed, n.avgAttempts.toFixed(2), n.customers,
      n.avgPrice, Math.round(n.sum), n.currentYtd, n.priorAvgYtd,
    ])
  );

  const opportunities = toCsv(
    ['Заказчик', 'ИНН', 'Предмет', 'Ниша', 'Закон', 'НМЦК', 'Попыток', 'Провалов',
      'Изменение НМЦК', 'Последняя публикация', 'Месяцы публикаций', 'Номер', 'Ссылка'],
    result.opportunities.map((o) => [
      o.customerName, o.customerInn, o.title, o.niche, `${o.law}-ФЗ`, o.maxPrice,
      o.attemptCount, o.failedAttempts, o.priceDrift, o.lastPublishDate,
      o.months.join(','), o.lastPurchaseNumber, o.url,
    ])
  );

  const purchases = toCsv(
    ['Номер', 'Дата', 'Год', 'Месяц', 'Закон', 'Заказчик', 'ИНН', 'Предмет', 'Ниша',
      'ОКПД2', 'НМЦК', 'Способ', 'Исход', 'Доказательство', 'Ссылка'],
    result.purchases.map((p) => [
      p.purchaseNumber, p.publishDate, p.year, p.month, `${p.law}-ФЗ`, p.customerName,
      p.customerInn, p.purchaseObject, p.niche, (p.okpd || []).join(' '), p.maxPrice,
      p.placingWay, OUTCOME_LABELS[p.outcome] || p.outcome,
      (p.evidence || []).map((e) => e.match).join(' | '), p.url,
    ])
  );

  return { niches, opportunities, purchases };
}

module.exports = { buildMarkdown, buildCsvs, toCsv, money, percent, MONTHS };
