'use strict';
/**
 * Поиск переобъявлений: цепочек закупок, которые заказчик публикует повторно
 * после провала.
 *
 * Это ключевой сигнал для входа. Одна несостоявшаяся закупка — случайность.
 * Третье переобъявление того же предмета тем же заказчиком означает, что
 * потребность реальная, денег в бюджете достаточно, а поставщиков нет.
 */

const STOPWORDS = new Set([
  'на', 'для', 'в', 'и', 'с', 'по', 'от', 'к', 'о', 'об', 'из', 'за', 'при', 'до',
  'нужд', 'нужды', 'обеспечения', 'оказание', 'оказанию', 'выполнение', 'выполнению',
  'поставка', 'поставку', 'поставки', 'услуг', 'услуги', 'услугам', 'работ', 'работы',
  'год', 'года', 'году', 'годов', 'квартал', 'период', 'муниципального', 'муниципальное',
  'государственного', 'бюджетного', 'учреждения', 'учреждение', 'заказчика',
]);

/** Приводит название к набору значимых токенов. */
function tokenize(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/20\d{2}/g, ' ') // годы мешают сопоставлению между попытками
    .replace(/[^а-яa-z0-9]+/gi, ' ')
    .split(' ')
    .filter((t) => t.length > 2 && !STOPWORDS.has(t) && !/^\d+$/.test(t));
}

/** Мера схожести Жаккара для двух наборов токенов. */
function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let intersection = 0;
  for (const token of a) if (b.has(token)) intersection += 1;
  return intersection / (a.size + b.size - intersection);
}

/** Ключ заказчика: ИНН надёжнее названия, но название — рабочий запасной вариант. */
function customerKey(record) {
  return record.customerInn || (record.customerName || '').toLowerCase().replace(/\s+/g, ' ').trim() || 'unknown';
}

/**
 * Группирует закупки в цепочки переобъявлений.
 *
 * @param {Array<object>} purchases — записи с purchaseObject, customerInn, publishDate
 * @param {object} [opts]
 * @param {number} [opts.threshold=0.6] — порог схожести названий
 * @param {number} [opts.maxGapDays=550] — максимальный разрыв между попытками
 * @returns {Array<{ id, customerName, customerInn, title, attempts: object[], niche }>}
 */
function clusterRepublications(purchases, opts = {}) {
  const threshold = opts.threshold ?? 0.6;
  const maxGapDays = opts.maxGapDays ?? 550;

  const byCustomer = new Map();
  for (const p of purchases) {
    const key = customerKey(p);
    if (!byCustomer.has(key)) byCustomer.set(key, []);
    byCustomer.get(key).push(p);
  }

  const clusters = [];
  let counter = 0;

  for (const [key, items] of byCustomer) {
    const sorted = items
      .slice()
      .sort((a, b) => String(a.publishDate || '').localeCompare(String(b.publishDate || '')));

    const open = []; // активные цепочки этого заказчика
    for (const item of sorted) {
      const tokens = new Set(tokenize(item.purchaseObject));
      let match = null;
      let bestScore = threshold;

      for (const cluster of open) {
        const gap = daysBetween(cluster.lastDate, item.publishDate);
        if (gap !== null && gap > maxGapDays) continue;
        const score = jaccard(cluster.tokens, tokens);
        if (score >= bestScore) {
          bestScore = score;
          match = cluster;
        }
      }

      if (match) {
        match.attempts.push(item);
        match.lastDate = item.publishDate || match.lastDate;
        for (const t of tokens) match.tokens.add(t); // цепочка накапливает словарь
      } else {
        counter += 1;
        open.push({
          id: `C${counter}`,
          customerKey: key,
          customerName: item.customerName,
          customerInn: item.customerInn,
          title: item.purchaseObject,
          tokens,
          lastDate: item.publishDate,
          attempts: [item],
        });
      }
    }

    clusters.push(...open);
  }

  return clusters.map((c) => ({
    id: c.id,
    customerName: c.customerName,
    customerInn: c.customerInn,
    title: c.title,
    attempts: c.attempts,
    attemptCount: c.attempts.length,
  }));
}

function daysBetween(a, b) {
  if (!a || !b) return null;
  const t1 = Date.parse(a);
  const t2 = Date.parse(b);
  if (!Number.isFinite(t1) || !Number.isFinite(t2)) return null;
  return Math.abs(t2 - t1) / 86400000;
}

module.exports = { clusterRepublications, tokenize, jaccard, daysBetween, customerKey };
