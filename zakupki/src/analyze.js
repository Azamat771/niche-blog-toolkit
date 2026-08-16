'use strict';
/**
 * Сведение записей в аналитику: динамика по годам, сравнение с текущим годом
 * и рейтинг ниш по «пустоте» — то есть по тому, насколько там нет конкурентов.
 */

const { OUTCOME, reduceOutcomes } = require('./classify');
const { classifyNiche } = require('./taxonomy');
const { clusterRepublications } = require('./cluster');

const EIS_SEARCH_URL = 'https://zakupki.gov.ru/epz/order/extendedsearch/results.html?searchString=';

/**
 * Склеивает извещения с протоколами и отменами по номеру закупки.
 * @returns {Array<object>} закупки с полем outcome
 */
function joinRecords(records) {
  const notifications = new Map();
  const verdicts = new Map();

  for (const record of records) {
    if (record.kind === 'notification') {
      // при нескольких версиях извещения берём самую позднюю
      const prev = notifications.get(record.purchaseNumber);
      if (!prev || String(record.publishDate || '') >= String(prev.publishDate || '')) {
        notifications.set(record.purchaseNumber, record);
      }
    } else if (record.kind === 'protocol' || record.kind === 'cancel') {
      if (!verdicts.has(record.purchaseNumber)) verdicts.set(record.purchaseNumber, []);
      verdicts.get(record.purchaseNumber).push(record);
    }
  }

  const purchases = [];
  for (const [number, notification] of notifications) {
    const related = verdicts.get(number) || [];
    const reduced = reduceOutcomes(related);
    const niche = classifyNiche(notification);
    purchases.push({
      ...notification,
      niche: niche.label,
      nicheKey: niche.key,
      nicheSource: niche.source,
      outcome: related.length ? reduced.outcome : OUTCOME.UNKNOWN,
      evidence: reduced.evidence.slice(0, 3),
      documentsCount: related.length,
      year: notification.publishDate ? Number(notification.publishDate.slice(0, 4)) : null,
      month: notification.publishDate ? Number(notification.publishDate.slice(5, 7)) : null,
      url: EIS_SEARCH_URL + number,
    });
  }

  // Протоколы без извещения (архив извещения не выгружен) — считаем отдельно,
  // чтобы не делать вид, что данные полные.
  const orphans = [...verdicts.keys()].filter((n) => !notifications.has(n)).length;

  return { purchases, orphanVerdicts: orphans };
}

function isFailure(outcome) {
  return outcome === OUTCOME.NO_BIDS || outcome === OUTCOME.ALL_REJECTED;
}

/** Пустая корзина счётчиков. */
function emptyStats() {
  return {
    total: 0,
    noBids: 0,
    singleBid: 0,
    allRejected: 0,
    cancelled: 0,
    completed: 0,
    unknown: 0,
    sum: 0,
  };
}

function addToStats(stats, purchase) {
  stats.total += 1;
  stats.sum += purchase.maxPrice || 0;
  switch (purchase.outcome) {
    case OUTCOME.NO_BIDS: stats.noBids += 1; break;
    case OUTCOME.SINGLE_BID: stats.singleBid += 1; break;
    case OUTCOME.ALL_REJECTED: stats.allRejected += 1; break;
    case OUTCOME.CANCELLED: stats.cancelled += 1; break;
    case OUTCOME.COMPLETED: stats.completed += 1; break;
    case OUTCOME.FAILED_OTHER: stats.allRejected += 1; break;
    default: stats.unknown += 1;
  }
}

/**
 * Динамика по годам. Для честного сравнения с текущим (неполным) годом
 * дополнительно считается YTD-срез: только месяцы 1..cutoffMonth каждого года.
 */
function yearlyDynamics(purchases, currentYear, cutoffMonth) {
  const byYear = new Map();
  const ytdByYear = new Map();

  for (const p of purchases) {
    if (!p.year) continue;
    if (!byYear.has(p.year)) byYear.set(p.year, emptyStats());
    addToStats(byYear.get(p.year), p);

    if (p.month && p.month <= cutoffMonth) {
      if (!ytdByYear.has(p.year)) ytdByYear.set(p.year, emptyStats());
      addToStats(ytdByYear.get(p.year), p);
    }
  }

  const years = [...byYear.keys()].sort((a, b) => a - b);
  return {
    cutoffMonth,
    currentYear,
    full: years.map((year) => ({ year, ...byYear.get(year) })),
    ytd: years.map((year) => ({ year, ...(ytdByYear.get(year) || emptyStats()) })),
  };
}

/** Гистограмма месяцев публикации — подсказывает, когда готовиться к следующей волне. */
function seasonality(purchases) {
  const months = new Array(12).fill(0);
  for (const p of purchases) if (p.month) months[p.month - 1] += 1;
  const max = Math.max(...months);
  const peaks = months
    .map((count, idx) => ({ month: idx + 1, count }))
    .filter((m) => max > 0 && m.count >= max * 0.7)
    .map((m) => m.month);
  return { months, peaks };
}

/**
 * Рейтинг ниш. Чем выше score, тем привлекательнее заход:
 * много закупок без заявок, заказчики переобъявляют, спрос повторяется.
 */
function rankNiches(purchases, clusters, opts = {}) {
  const minCount = opts.minCount ?? 4;
  const currentYear = opts.currentYear;
  const cutoffMonth = opts.cutoffMonth ?? 12;

  const clusterByPurchase = new Map();
  for (const cluster of clusters) {
    for (const attempt of cluster.attempts) {
      clusterByPurchase.set(attempt.purchaseNumber, cluster);
    }
  }

  const groups = new Map();
  for (const p of purchases) {
    if (!groups.has(p.nicheKey)) {
      groups.set(p.nicheKey, { key: p.nicheKey, label: p.niche, items: [] });
    }
    groups.get(p.nicheKey).items.push(p);
  }

  const totalYears = new Set(purchases.map((p) => p.year).filter(Boolean)).size || 1;
  const ranked = [];

  for (const group of groups.values()) {
    const items = group.items;
    const stats = emptyStats();
    for (const item of items) addToStats(stats, item);

    const withVerdict = stats.total - stats.unknown;
    const zeroBidRate = withVerdict > 0 ? stats.noBids / withVerdict : 0;
    const failRate = withVerdict > 0 ? (stats.noBids + stats.allRejected) / withVerdict : 0;

    const attemptCounts = [];
    const seenClusters = new Set();
    for (const item of items) {
      const cluster = clusterByPurchase.get(item.purchaseNumber);
      if (cluster && !seenClusters.has(cluster.id)) {
        seenClusters.add(cluster.id);
        attemptCounts.push(cluster.attemptCount);
      }
    }
    const avgAttempts = attemptCounts.length
      ? attemptCounts.reduce((a, b) => a + b, 0) / attemptCounts.length
      : 1;

    const customers = new Set(items.map((i) => i.customerInn || i.customerName)).size;
    const yearsPresent = new Set(items.map((i) => i.year).filter(Boolean)).size;
    const recurrence = yearsPresent / totalYears;

    const currentYtd = items.filter(
      (i) => i.year === currentYear && i.month && i.month <= cutoffMonth
    ).length;
    const priorYtdYears = new Map();
    for (const i of items) {
      if (i.year && i.year < currentYear && i.month && i.month <= cutoffMonth) {
        priorYtdYears.set(i.year, (priorYtdYears.get(i.year) || 0) + 1);
      }
    }
    const priorAvg = priorYtdYears.size
      ? [...priorYtdYears.values()].reduce((a, b) => a + b, 0) / priorYtdYears.size
      : 0;
    const growth = priorAvg > 0 ? currentYtd / priorAvg : (currentYtd > 0 ? 1.5 : 0);

    const score =
      35 * zeroBidRate +
      20 * Math.min(Math.max(avgAttempts - 1, 0) / 2, 1) +
      15 * Math.min(Math.log10(stats.total + 1) / 2, 1) +
      10 * Math.min(customers / 5, 1) +
      10 * recurrence +
      10 * Math.min(growth / 1.5, 1);

    ranked.push({
      key: group.key,
      label: group.label,
      ...stats,
      avgPrice: stats.total ? Math.round(stats.sum / stats.total) : 0,
      zeroBidRate,
      failRate,
      avgAttempts,
      customers,
      recurrence,
      currentYtd,
      priorAvgYtd: Number(priorAvg.toFixed(1)),
      growth,
      seasonality: seasonality(items),
      score: Number(score.toFixed(1)),
      enoughData: stats.total >= minCount,
    });
  }

  return ranked.sort((a, b) => b.score - a.score);
}

/**
 * Конкретные точки входа: цепочки, где последняя попытка провалилась
 * из-за отсутствия заявок. Это то, куда можно подавать заявку прямо сейчас
 * или ждать очередного переобъявления.
 */
function findOpportunities(clusters, opts = {}) {
  const freshAfter = opts.freshAfter || null; // 'YYYY-MM-DD'
  const out = [];

  for (const cluster of clusters) {
    const attempts = cluster.attempts
      .slice()
      .sort((a, b) => String(a.publishDate || '').localeCompare(String(b.publishDate || '')));
    const last = attempts[attempts.length - 1];
    if (!last) continue;

    const failedAttempts = attempts.filter((a) => isFailure(a.outcome)).length;
    if (!isFailure(last.outcome)) continue;
    if (freshAfter && String(last.publishDate || '') < freshAfter) continue;

    const prices = attempts.map((a) => a.maxPrice).filter((p) => p);
    const priceDrift = prices.length > 1 ? prices[prices.length - 1] - prices[0] : 0;

    out.push({
      customerName: cluster.customerName,
      customerInn: cluster.customerInn,
      title: last.purchaseObject,
      niche: last.niche,
      law: last.law,
      lastPurchaseNumber: last.purchaseNumber,
      lastPublishDate: last.publishDate,
      lastOutcome: last.outcome,
      maxPrice: last.maxPrice,
      attemptCount: cluster.attemptCount,
      failedAttempts,
      priceDrift,
      months: [...new Set(attempts.map((a) => a.month).filter(Boolean))].sort((a, b) => a - b),
      url: EIS_SEARCH_URL + last.purchaseNumber,
    });
  }

  return out.sort((a, b) => {
    if (b.failedAttempts !== a.failedAttempts) return b.failedAttempts - a.failedAttempts;
    return (b.maxPrice || 0) - (a.maxPrice || 0);
  });
}

/**
 * Полный прогон анализа.
 * @param {Array<object>} records — нормализованные записи из extract.js
 * @param {object} opts — { budgetMax, budgetMin, currentDate, minCount, laws }
 */
function analyze(records, opts = {}) {
  const budgetMax = opts.budgetMax ?? Infinity;
  const budgetMin = opts.budgetMin ?? 0;
  const currentDate = opts.currentDate || new Date().toISOString().slice(0, 10);
  const currentYear = Number(currentDate.slice(0, 4));
  const cutoffMonth = Number(currentDate.slice(5, 7));
  const laws = opts.laws || [44, 223];

  const { purchases, orphanVerdicts } = joinRecords(records);

  const scoped = purchases.filter((p) => laws.includes(p.law));
  const inBudget = scoped.filter(
    (p) => p.maxPrice === null || (p.maxPrice >= budgetMin && p.maxPrice <= budgetMax)
  );

  // Цепочки считаем по всем закупкам в бюджете, включая успешные:
  // без них не видно, что переобъявление в итоге сработало.
  const clusters = clusterRepublications(inBudget, opts.cluster);
  const republished = clusters.filter((c) => c.attemptCount > 1);

  const freshAfter = shiftMonths(currentDate, -(opts.freshMonths ?? 12));

  return {
    meta: {
      generatedFor: currentDate,
      currentYear,
      cutoffMonth,
      laws,
      budgetMin,
      budgetMax: budgetMax === Infinity ? null : budgetMax,
      totalRecords: records.length,
      totalPurchases: purchases.length,
      inScope: scoped.length,
      inBudget: inBudget.length,
      orphanVerdicts,
      unknownOutcome: inBudget.filter((p) => p.outcome === OUTCOME.UNKNOWN).length,
    },
    dynamics: yearlyDynamics(inBudget, currentYear, cutoffMonth),
    niches: rankNiches(inBudget, clusters, { currentYear, cutoffMonth, minCount: opts.minCount }),
    clusters: republished,
    opportunities: findOpportunities(clusters, { freshAfter }),
    purchases: inBudget,
  };
}

function shiftMonths(isoDate, delta) {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + delta);
  return d.toISOString().slice(0, 10);
}

module.exports = {
  analyze,
  joinRecords,
  yearlyDynamics,
  rankNiches,
  findOpportunities,
  seasonality,
  shiftMonths,
  EIS_SEARCH_URL,
};
