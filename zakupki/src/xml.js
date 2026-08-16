'use strict';
/**
 * Терпимый XML-парсер под машинно-сгенерированные документы ЕИС.
 *
 * Осознанное решение: не привязываемся к конкретной XSD. Схемы 44-ФЗ и 223-ФЗ
 * менялись от года к году (и продолжают), поэтому парсер строит дерево, а
 * извлечение работает поиском по названиям тегов без учёта пространств имён.
 */

const ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

function decodeEntities(text) {
  if (!text.includes('&')) return text;
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X'
        ? parseInt(body.slice(2), 16)
        : parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    const named = ENTITIES[body.toLowerCase()];
    return named === undefined ? match : named;
  });
}

/** Отбрасывает префикс пространства имён: ns2:purchaseNumber -> purchaseNumber */
function localName(name) {
  const idx = name.indexOf(':');
  return idx === -1 ? name : name.slice(idx + 1);
}

function makeNode(name) {
  return { name, attrs: {}, children: [], text: '' };
}

/**
 * Разбирает XML-документ в дерево узлов { name, attrs, children, text }.
 * Имена тегов и атрибутов — без префиксов пространств имён.
 */
function parseXml(source) {
  const root = makeNode('#document');
  const stack = [root];
  let i = 0;

  const top = () => stack[stack.length - 1];

  while (i < source.length) {
    const lt = source.indexOf('<', i);
    if (lt === -1) {
      top().text += decodeEntities(source.slice(i));
      break;
    }
    if (lt > i) top().text += decodeEntities(source.slice(i, lt));

    if (source.startsWith('<![CDATA[', lt)) {
      const end = source.indexOf(']]>', lt);
      const stop = end === -1 ? source.length : end;
      top().text += source.slice(lt + 9, stop);
      i = end === -1 ? source.length : end + 3;
      continue;
    }
    if (source.startsWith('<!--', lt)) {
      const end = source.indexOf('-->', lt);
      i = end === -1 ? source.length : end + 3;
      continue;
    }
    if (source.startsWith('<?', lt)) {
      const end = source.indexOf('?>', lt);
      i = end === -1 ? source.length : end + 2;
      continue;
    }
    if (source.startsWith('<!', lt)) {
      const end = source.indexOf('>', lt);
      i = end === -1 ? source.length : end + 1;
      continue;
    }

    const gt = source.indexOf('>', lt);
    if (gt === -1) break;
    const inner = source.slice(lt + 1, gt);

    if (inner[0] === '/') {
      const closing = localName(inner.slice(1).trim());
      // закрываем ближайший подходящий узел, не разваливаясь на кривой вложенности
      for (let d = stack.length - 1; d > 0; d -= 1) {
        if (stack[d].name === closing) {
          stack.length = d;
          break;
        }
      }
      i = gt + 1;
      continue;
    }

    const selfClosing = inner.endsWith('/');
    const body = selfClosing ? inner.slice(0, -1) : inner;
    const nameMatch = /^([^\s/>]+)/.exec(body);
    if (!nameMatch) {
      i = gt + 1;
      continue;
    }

    const node = makeNode(localName(nameMatch[1]));
    const attrRe = /([^\s=]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
    let attr;
    while ((attr = attrRe.exec(body.slice(nameMatch[1].length))) !== null) {
      const value = attr[3] !== undefined ? attr[3] : attr[4];
      node.attrs[localName(attr[1])] = decodeEntities(value);
    }

    top().children.push(node);
    if (!selfClosing) stack.push(node);
    i = gt + 1;
  }

  return root;
}

/** Обходит дерево сверху вниз, вызывая fn для каждого узла. */
function walk(node, fn) {
  fn(node);
  for (const child of node.children) walk(child, fn);
}

/** Все потомки с указанным именем (регистронезависимо). */
function findAll(node, name) {
  const target = String(name).toLowerCase();
  const found = [];
  walk(node, (n) => {
    if (n.name.toLowerCase() === target) found.push(n);
  });
  return found;
}

/** Первый потомок, чьё имя входит в список кандидатов (порядок = приоритет). */
function findFirstOf(node, names) {
  for (const name of names) {
    const hits = findAll(node, name);
    if (hits.length) return hits[0];
  }
  return null;
}

/** Собственный текст узла + текст всех потомков. */
function deepText(node) {
  let out = node.text || '';
  for (const child of node.children) out += ` ${deepText(child)}`;
  return out.replace(/\s+/g, ' ').trim();
}

/**
 * Первое непустое текстовое значение среди тегов-кандидатов.
 * Основной рабочий инструмент извлечения: схемы разные, имена полей плавают.
 */
function pickText(node, names) {
  for (const name of names) {
    for (const hit of findAll(node, name)) {
      const value = deepText(hit);
      if (value) return value;
    }
  }
  return '';
}

/**
 * Значения ПЕРВОГО кандидата, у которого что-то нашлось.
 *
 * Отличие от pickAll принципиальное: для сумм нельзя смешивать разные теги.
 * Если в документе есть и <maxPrice> лотов, и общий <sum>, объединённый список
 * даст завышенный максимум. Здесь же берётся один тег — но все его вхождения,
 * что корректно отрабатывает многолотовые извещения.
 */
function pickFirstGroup(node, names) {
  for (const name of names) {
    const values = [];
    for (const hit of findAll(node, name)) {
      const value = deepText(hit);
      if (value) values.push(value);
    }
    if (values.length) return values;
  }
  return [];
}

/** Все текстовые значения тегов-кандидатов (без пустых и дублей). */
function pickAll(node, names) {
  const values = [];
  for (const name of names) {
    for (const hit of findAll(node, name)) {
      const value = deepText(hit);
      if (value && !values.includes(value)) values.push(value);
    }
  }
  return values;
}

module.exports = {
  parseXml,
  walk,
  findAll,
  findFirstOf,
  deepText,
  pickText,
  pickAll,
  pickFirstGroup,
  decodeEntities,
  localName,
};
