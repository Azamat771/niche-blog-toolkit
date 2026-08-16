'use strict';
/**
 * Превращение XML-документов ЕИС в плоские записи.
 *
 * Списки тегов-кандидатов упорядочены по приоритету. Так сделано намеренно:
 * между редакциями схем 44-ФЗ одно и то же поле называется по-разному, а в
 * 223-ФЗ часть полей может отсутствовать вовсе. Первый непустой — побеждает.
 */

const { parseXml, walk, findAll, deepText, pickText, pickAll, pickFirstGroup } = require('./xml');
const { classifyDocument } = require('./classify');

const FIELDS = {
  purchaseNumber: [
    'purchaseNumber',
    'purchaseNoticeNumber',
    'noticeNumber',
    'purchaseRegNumber',
    'registrationNumber',
  ],
  purchaseObject: [
    'purchaseObjectInfo',
    'purchaseObjectName',
    'purchaseObject',
    'objectInfo',
    'nameOfPurchase',
    'subject',
    'lotName',
    'name',
  ],
  customerName: [
    'fullName',
    'shortName',
    'customerFullName',
    'organizationName',
    'responsibleOrgFullName',
    'placerFullName',
  ],
  customerInn: ['INN', 'inn', 'customerInn', 'organizationInn'],
  customerRegNum: ['regNum', 'customerRegistryNum', 'organizationRegNum', 'consRegistryNum'],
  maxPrice: [
    'maxPrice',
    'maxSum',
    'initialSum',
    'contractPrice',
    'priceOfContract',
    'lotMaxPrice',
    'startMaxPrice',
    'sum',
  ],
  currency: ['currency', 'currencyCode'],
  publishDate: [
    'publishDTInEIS',
    'docPublishDate',
    'publishDate',
    'createDateTime',
    'publicationDateTime',
  ],
  endDate: [
    'collectingEndDate',
    'applicationsEndDate',
    'endDate',
    'bidderEndDate',
    'collectingProcedural',
  ],
  placingWay: ['placingWay', 'purchaseMethod', 'placingWayName', 'purchaseCodeName'],
  etp: ['ETP', 'etp', 'electronicPlatform', 'tradeSite'],
  okpd: ['OKPD2', 'OKPD', 'okpd2', 'OKPDCode'],
  okpdCode: ['code', 'OKPDCode', 'OKPD2Code'],
  region: ['region', 'subjectRF', 'KLADR', 'regionName', 'territory'],
  cancelReason: ['cancelReason', 'reason', 'cancelBasis', 'basis'],
};

/** Определяет тип документа по имени файла и корневым тегам. */
function detectDocumentKind(fileName, tagNames) {
  const name = fileName.toLowerCase();
  const tags = tagNames.map((t) => t.toLowerCase());
  const has = (re) => tags.some((t) => re.test(t)) || re.test(name);

  if (has(/cancel|annul/)) return 'cancel';
  if (has(/protocol/)) return 'protocol';
  if (has(/notification|notice|invitation|purchasenotice/)) return 'notification';
  if (has(/contract/)) return 'contract';
  return 'other';
}

/**
 * 44 или 223 — по пути внутри архива и по пространствам имён.
 *
 * Намеренно не ищем просто «223»: номера закупок 44-ФЗ сплошь и рядом содержат
 * эти цифры, и такая проверка отправила бы половину данных не в тот закон.
 * Ищем только однозначные маркеры: fz223 / 223fz / сегмент пути / URI схемы.
 */
const LAW_223_MARKERS = [
  /(^|[^a-z0-9])223[\s_-]?fz([^a-z0-9]|$)/i,
  /(^|[^a-z0-9])fz[\s_-]?223([^a-z0-9]|$)/i,
  /[/\\_]223[/\\_]/,
  /zakupki\.gov\.ru\/223/i,
  /out[/\\]published/i,
];

function detectLaw(fileName, source = '', nsProbe = '') {
  const probe = `${fileName} ${source} ${nsProbe}`;
  return LAW_223_MARKERS.some((re) => re.test(probe)) ? 223 : 44;
}

function toNumber(value) {
  if (!value) return null;
  const cleaned = String(value).replace(/\s| /g, '').replace(',', '.');
  const n = Number.parseFloat(cleaned);
  return Number.isFinite(n) ? n : null;
}

function toDate(value) {
  if (!value) return null;
  const m = /(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  const ru = /(\d{2})\.(\d{2})\.(\d{4})/.exec(value);
  if (ru) return `${ru[3]}-${ru[2]}-${ru[1]}`;
  return null;
}

/** Коды ОКПД2 из любых мест документа, в нормальной форме NN.NN.NN. */
function extractOkpd(root) {
  const codes = new Set();
  for (const node of findAll(root, 'OKPD2').concat(findAll(root, 'OKPD'))) {
    const code = pickText(node, FIELDS.okpdCode) || deepText(node);
    const m = /\b(\d{2}(?:\.\d{1,2}){0,4})\b/.exec(code);
    if (m) codes.add(m[1]);
  }
  // запасной путь: коды встречаются и просто в тексте позиций
  if (!codes.size) {
    walk(root, (node) => {
      if (/okpd/i.test(node.name)) {
        const m = /\b(\d{2}(?:\.\d{1,2}){2,4})\b/.exec(deepText(node));
        if (m) codes.add(m[1]);
      }
    });
  }
  return [...codes];
}

/** ИНН заказчика: 10 цифр (юрлицо) или 12 (ИП). */
function extractInn(root) {
  for (const value of pickAll(root, FIELDS.customerInn)) {
    const m = /\b(\d{10}|\d{12})\b/.exec(value);
    if (m) return m[1];
  }
  return '';
}

/**
 * Разбирает один XML-файл в запись.
 * @returns {object|null} запись или null, если документ нам не интересен
 */
function extractRecord(xmlText, fileName, archiveName = '') {
  const root = parseXml(xmlText);

  const tagNames = [];
  const enumValues = [];
  const namespaces = new Set();
  walk(root, (node) => {
    if (node.name !== '#document') tagNames.push(node.name);
    if (/^(code|indicator|status|state|reason|type)$/i.test(node.name)) {
      const value = deepText(node);
      if (value && value.length < 60) enumValues.push(value);
    }
    for (const value of Object.values(node.attrs)) {
      if (/^https?:\/\//i.test(value)) namespaces.add(value);
    }
  });
  const nsProbe = [...namespaces].join(' ');

  const kind = detectDocumentKind(fileName, tagNames);
  if (kind === 'other' || kind === 'contract') return null;

  const purchaseNumber = (pickText(root, FIELDS.purchaseNumber).match(/\b\d{11,25}\b/) || [''])[0]
    || pickText(root, FIELDS.purchaseNumber).trim();
  if (!purchaseNumber) return null;

  const fullText = deepText(root);
  const base = {
    kind,
    law: detectLaw(fileName, archiveName, nsProbe),
    purchaseNumber,
    sourceFile: fileName,
    sourceArchive: archiveName,
  };

  if (kind === 'notification') {
    // Один тег-источник, но все его вхождения. Для многолотовых извещений
    // берём максимальный лот: заявка подаётся на лот, а не на извещение целиком,
    // поэтому именно лот должен проходить бюджетный фильтр.
    const prices = pickFirstGroup(root, FIELDS.maxPrice)
      .map(toNumber)
      .filter((n) => n !== null && n > 0);
    return {
      ...base,
      purchaseObject: pickText(root, FIELDS.purchaseObject).slice(0, 500),
      customerName: pickText(root, FIELDS.customerName).slice(0, 300),
      customerInn: extractInn(root),
      customerRegNum: pickText(root, FIELDS.customerRegNum),
      maxPrice: prices.length ? Math.max(...prices) : null,
      publishDate: toDate(pickText(root, FIELDS.publishDate)),
      endDate: toDate(pickText(root, FIELDS.endDate)),
      placingWay: pickText(root, FIELDS.placingWay).slice(0, 200),
      etp: pickText(root, FIELDS.etp).slice(0, 200),
      okpd: extractOkpd(root),
      region: pickText(root, FIELDS.region).slice(0, 200),
    };
  }

  // протокол или отмена — нас интересует исход
  const verdict = classifyDocument({
    text: fullText,
    tags: tagNames,
    values: enumValues,
    fileName,
  });
  return {
    ...base,
    date: toDate(pickText(root, FIELDS.publishDate)),
    outcome: verdict.outcome,
    priority: verdict.priority,
    evidence: verdict.evidence.slice(0, 4),
    reason: kind === 'cancel' ? pickText(root, FIELDS.cancelReason).slice(0, 300) : '',
  };
}

module.exports = {
  extractRecord,
  detectDocumentKind,
  detectLaw,
  extractOkpd,
  extractInn,
  toNumber,
  toDate,
  FIELDS,
};
