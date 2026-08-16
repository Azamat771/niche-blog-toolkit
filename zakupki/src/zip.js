'use strict';
/**
 * Чтение ZIP-архивов из буфера через встроенный zlib.
 * Поддержаны методы 0 (stored) и 8 (deflate) + ZIP64-поля размеров,
 * потому что месячные выгрузки ЕИС легко переваливают за 4 ГБ границы полей.
 */

const zlib = require('zlib');

const SIG_EOCD = 0x06054b50;
const SIG_EOCD64_LOCATOR = 0x07064b50;
const SIG_EOCD64 = 0x06064b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;

class ZipError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ZipError';
  }
}

/** Ищет End of Central Directory с конца буфера (комментарий до 64 КБ). */
function findEocd(buf) {
  const minOffset = Math.max(0, buf.length - 0x10000 - 22);
  for (let i = buf.length - 22; i >= minOffset; i -= 1) {
    if (buf.readUInt32LE(i) === SIG_EOCD) return i;
  }
  throw new ZipError('это не ZIP-архив: не найден End of Central Directory');
}

/** Возвращает { entriesCount, centralOffset } с учётом ZIP64. */
function readDirectoryLocation(buf, eocd) {
  let entriesCount = buf.readUInt16LE(eocd + 10);
  let centralOffset = buf.readUInt32LE(eocd + 16);

  const needsZip64 = entriesCount === 0xffff || centralOffset === 0xffffffff;
  if (!needsZip64) return { entriesCount, centralOffset };

  const locator = eocd - 20;
  if (locator < 0 || buf.readUInt32LE(locator) !== SIG_EOCD64_LOCATOR) {
    throw new ZipError('нужен ZIP64, но локатор EOCD64 не найден');
  }
  const eocd64 = Number(buf.readBigUInt64LE(locator + 8));
  if (buf.readUInt32LE(eocd64) !== SIG_EOCD64) {
    throw new ZipError('повреждённая запись EOCD64');
  }
  entriesCount = Number(buf.readBigUInt64LE(eocd64 + 32));
  centralOffset = Number(buf.readBigUInt64LE(eocd64 + 48));
  return { entriesCount, centralOffset };
}

/**
 * Разбирает extra-поле ZIP64 и подставляет реальные размеры/смещение
 * вместо маркеров 0xFFFFFFFF.
 */
function applyZip64Extra(extra, entry) {
  let off = 0;
  while (off + 4 <= extra.length) {
    const id = extra.readUInt16LE(off);
    const size = extra.readUInt16LE(off + 2);
    const body = extra.slice(off + 4, off + 4 + size);
    if (id === 0x0001) {
      let p = 0;
      if (entry.uncompressedSize === 0xffffffff && p + 8 <= body.length) {
        entry.uncompressedSize = Number(body.readBigUInt64LE(p));
        p += 8;
      }
      if (entry.compressedSize === 0xffffffff && p + 8 <= body.length) {
        entry.compressedSize = Number(body.readBigUInt64LE(p));
        p += 8;
      }
      if (entry.localHeaderOffset === 0xffffffff && p + 8 <= body.length) {
        entry.localHeaderOffset = Number(body.readBigUInt64LE(p));
        p += 8;
      }
    }
    off += 4 + size;
  }
}

/**
 * Список файлов архива без распаковки содержимого.
 * @returns {Array<{name, compressedSize, uncompressedSize, method, localHeaderOffset}>}
 */
function listEntries(buf) {
  const eocd = findEocd(buf);
  const { entriesCount, centralOffset } = readDirectoryLocation(buf, eocd);

  const entries = [];
  let pos = centralOffset;
  for (let i = 0; i < entriesCount; i += 1) {
    if (pos + 46 > buf.length || buf.readUInt32LE(pos) !== SIG_CENTRAL) break;

    const flags = buf.readUInt16LE(pos + 8);
    const nameLength = buf.readUInt16LE(pos + 28);
    const extraLength = buf.readUInt16LE(pos + 30);
    const commentLength = buf.readUInt16LE(pos + 32);

    const nameBuf = buf.slice(pos + 46, pos + 46 + nameLength);
    // бит 11 = имя в UTF-8; иначе исторически cp437/cp866 — нам важно лишь расширение
    const name = nameBuf.toString(flags & 0x800 ? 'utf8' : 'latin1');

    const entry = {
      name,
      method: buf.readUInt16LE(pos + 10),
      compressedSize: buf.readUInt32LE(pos + 20),
      uncompressedSize: buf.readUInt32LE(pos + 24),
      localHeaderOffset: buf.readUInt32LE(pos + 42),
    };
    applyZip64Extra(buf.slice(pos + 46 + nameLength, pos + 46 + nameLength + extraLength), entry);
    entries.push(entry);

    pos += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/** Распаковывает одну запись архива в Buffer. */
function readEntry(buf, entry) {
  const lh = entry.localHeaderOffset;
  if (buf.readUInt32LE(lh) !== SIG_LOCAL) {
    throw new ZipError(`повреждён локальный заголовок записи ${entry.name}`);
  }
  const nameLength = buf.readUInt16LE(lh + 26);
  const extraLength = buf.readUInt16LE(lh + 28);
  const start = lh + 30 + nameLength + extraLength;
  const raw = buf.slice(start, start + entry.compressedSize);

  if (entry.method === 0) return raw;
  if (entry.method === 8) return zlib.inflateRawSync(raw);
  throw new ZipError(`неподдерживаемый метод сжатия ${entry.method} у ${entry.name}`);
}

/**
 * Итератор по файлам архива, подходящим под фильтр.
 * @param {Buffer} buf
 * @param {(name: string) => boolean} filter
 * @yields {{ name: string, data: Buffer }}
 */
function* iterateFiles(buf, filter = () => true) {
  for (const entry of listEntries(buf)) {
    if (entry.name.endsWith('/')) continue; // каталог
    if (!filter(entry.name)) continue;
    yield { name: entry.name, data: readEntry(buf, entry) };
  }
}

module.exports = { listEntries, readEntry, iterateFiles, ZipError };
