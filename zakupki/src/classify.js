'use strict';
/**
 * Определение исхода закупки по тексту протокола / извещения об отмене.
 *
 * Почему маркерами, а не по XSD: имена тегов у протоколов 44-ФЗ отличаются
 * между редакциями (epProtocol*, protocolEF*, ...), а 223-ФЗ вообще почти не
 * структурирован — заказчик пишет причину прозой. Поэтому классификатор
 * смотрит и на имена тегов, и на текст, и складывает найденные доказательства
 * в запись, чтобы любой вывод можно было перепроверить руками.
 */

/** Исходы, ранжированные от самого информативного к самому общему. */
const OUTCOME = {
  NO_BIDS: 'NO_BIDS', // не подано ни одной заявки — наша основная цель
  SINGLE_BID: 'SINGLE_BID', // один участник: контракт с единственным поставщиком
  ALL_REJECTED: 'ALL_REJECTED', // заявки были, но все отклонены
  FAILED_OTHER: 'FAILED_OTHER', // несостоявшаяся, причина не распознана
  CANCELLED: 'CANCELLED', // извещение отменено заказчиком
  COMPLETED: 'COMPLETED', // определён победитель
  UNKNOWN: 'UNKNOWN',
};

/** Человекочитаемые названия для отчётов. */
const OUTCOME_LABELS = {
  NO_BIDS: 'Нет заявок',
  SINGLE_BID: 'Один участник',
  ALL_REJECTED: 'Все заявки отклонены',
  FAILED_OTHER: 'Не состоялась (прочее)',
  CANCELLED: 'Отменена',
  COMPLETED: 'Состоялась',
  UNKNOWN: 'Не определено',
};

/**
 * Правила проверяются сверху вниз, первое сработавшее побеждает.
 * priority нужен, чтобы при склейке нескольких протоколов одной закупки
 * выбрать наиболее конкретный вывод.
 *
 * Два правила написания шаблонов, оба выстраданы тестами:
 *   1) окончания слов пишем как [а-яё]*, а НЕ \w*: в JavaScript \w — это
 *      [A-Za-z0-9_], кириллицу он не покрывает, и шаблон молча не срабатывает;
 *   2) между значимыми словами допускаем вставку ([^.]{0,40}?) — в живых
 *      протоколах пишут «победителем аукциона признан», а не «победителем признан».
 */
const RULES = [
  {
    outcome: OUTCOME.NO_BIDS,
    priority: 100,
    text: [
      /не\s+подано\s+ни\s+одной\s+заявк/i,
      /не\s+подана\s+ни\s+одна\s+заявк/i,
      /не\s+поступило\s+ни\s+одной\s+заявк/i,
      /ни\s+одной\s+заявки\s+не\s+(?:было\s+)?(?:подано|поступило)/i,
      /отсутстви[а-яё]*\s+(?:[а-яё]+\s+){0,2}заяв(?:ок|ки)/i,
      /заявк[а-яё]*\s+на\s+участие\s+не\s+подавал/i,
      /по\s+окончании\s+срока\s+подачи\s+заявок\s+не\s+подано/i,
    ],
    tags: [/^noapplications$/i, /absenceofapplication/i, /^nobids$/i],
    values: [/^NO_APPLICATIONS$/i, /^ABSENCE_APPLICATIONS$/i],
  },
  {
    outcome: OUTCOME.SINGLE_BID,
    priority: 90,
    text: [
      /подана\s+(?:только\s+)?одна\s+заявка/i,
      /подан[ао]?\s+единственн[а-яё]+\s+заявк/i,
      /только\s+один\s+участник/i,
      /признан[а-яё]*[^.]{0,40}?единственн[а-яё]+\s+участник/i,
      /соответствует\s+только\s+одна\s+заявка/i,
      /единственн[а-яё]+\s+поставщик/i,
    ],
    tags: [/^oneapplication$/i, /singleapplication/i],
    values: [/^ONE_APPLICATION$/i, /^SINGLE_PARTICIPANT$/i],
  },
  {
    outcome: OUTCOME.ALL_REJECTED,
    priority: 80,
    text: [
      /все\s+заявки[^.]{0,40}?отклонен/i,
      /отклонены\s+все[^.]{0,30}?заявки/i,
      /ни\s+одна\s+заявка\s+не\s+соответству/i,
      /все\s+участник[а-яё]*[^.]{0,40}?не\s+соответствующ/i,
    ],
    tags: [/allapplicationsrejected/i],
    values: [/^ALL_REJECTED$/i],
  },
  {
    outcome: OUTCOME.CANCELLED,
    priority: 70,
    text: [
      /отмен[а-яё]*\s+(?:закупк|извещени|определени|процедур|электронн)/i,
      /об\s+отмене\s+(?:закупки|извещения|определения)/i,
      /аннулирован[а-яё]*\s+(?:закупк|извещени|процедур)/i,
    ],
    tags: [/cancel/i, /^annul/i],
    values: [/^CANCELLED$/i, /^CANCELED$/i],
  },
  {
    outcome: OUTCOME.FAILED_OTHER,
    priority: 60,
    text: [
      /признан[а-яё]*\s+несостоявш[а-яё]+/i,
      /признать\s+несостоявш[а-яё]+/i,
      /несостоявш[а-яё]+/i,
    ],
    tags: [/recognizedfailed/i, /abandoned/i, /^notplaced$/i],
    values: [/^FAILED$/i, /^ABANDONED$/i],
  },
  {
    outcome: OUTCOME.COMPLETED,
    priority: 40,
    text: [
      /победител[а-яё]+[^.]{0,40}?признан/i,
      /признан[а-яё]*[^.]{0,40}?победител/i,
      /заключить\s+контракт\s+с\s+победител/i,
    ],
    tags: [/^winner$/i, /^winnerindication$/i],
    values: [],
  },
];

/**
 * Классифицирует один документ.
 *
 * @param {object} input
 * @param {string} input.text  — весь текст документа
 * @param {string[]} input.tags — имена всех тегов документа
 * @param {string[]} [input.values] — значения перечислимых полей (code/indicator)
 * @param {string} [input.fileName]
 * @returns {{ outcome: string, priority: number, evidence: Array<{rule, where, match}> }}
 */
function classifyDocument({ text = '', tags = [], values = [], fileName = '' }) {
  const haystack = text.replace(/\s+/g, ' ');
  const evidence = [];
  let best = null;

  for (const rule of RULES) {
    let hit = null;

    for (const pattern of rule.text || []) {
      const m = pattern.exec(haystack);
      if (m) {
        hit = { rule: rule.outcome, where: 'text', match: trimMatch(haystack, m) };
        break;
      }
    }
    if (!hit) {
      for (const pattern of rule.tags || []) {
        const tag = tags.find((t) => pattern.test(t));
        if (tag) {
          hit = { rule: rule.outcome, where: 'tag', match: tag };
          break;
        }
      }
    }
    if (!hit) {
      for (const pattern of rule.values || []) {
        const value = values.find((v) => pattern.test(v));
        if (value) {
          hit = { rule: rule.outcome, where: 'value', match: value };
          break;
        }
      }
    }

    if (hit) {
      evidence.push(hit);
      if (!best || rule.priority > best.priority) {
        best = { outcome: rule.outcome, priority: rule.priority };
      }
    }
  }

  // Имя файла — слабая, но полезная подсказка, когда текст пустой.
  if (!best && /cancel/i.test(fileName)) {
    best = { outcome: OUTCOME.CANCELLED, priority: 30 };
    evidence.push({ rule: OUTCOME.CANCELLED, where: 'fileName', match: fileName });
  }

  return {
    outcome: best ? best.outcome : OUTCOME.UNKNOWN,
    priority: best ? best.priority : 0,
    evidence,
  };
}

function trimMatch(haystack, match) {
  const start = Math.max(0, match.index - 30);
  const end = Math.min(haystack.length, match.index + match[0].length + 30);
  return `…${haystack.slice(start, end).trim()}…`;
}

/**
 * Сводит несколько документов одной закупки к одному исходу.
 * Побеждает самый конкретный вывод; отмена перебивает всё, если она позже.
 */
function reduceOutcomes(classified) {
  if (!classified.length) return { outcome: OUTCOME.UNKNOWN, evidence: [] };

  const cancelled = classified.filter((c) => c.outcome === OUTCOME.CANCELLED);
  const others = classified.filter((c) => c.outcome !== OUTCOME.CANCELLED);

  // Отмена без протоколов по существу = закупку свернули до итогов.
  if (cancelled.length && !others.some((o) => o.priority >= 60)) {
    return {
      outcome: OUTCOME.CANCELLED,
      evidence: cancelled.flatMap((c) => c.evidence),
    };
  }

  const winner = others.concat(cancelled).reduce((a, b) => (b.priority > a.priority ? b : a));
  return { outcome: winner.outcome, evidence: classified.flatMap((c) => c.evidence) };
}

module.exports = { OUTCOME, OUTCOME_LABELS, RULES, classifyDocument, reduceOutcomes };
