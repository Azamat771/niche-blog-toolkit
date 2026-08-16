'use strict';
/**
 * Разбор локальных ZIP-архивов ЕИС в нормализованные записи.
 * Работает и с тем, что скачал fetch.js, и с архивами, выкачанными вручную
 * (FileZilla, wget) — достаточно указать каталог.
 */

const fs = require('fs');
const path = require('path');
const { iterateFiles } = require('./zip');
const { extractRecord } = require('./extract');

/** Рекурсивно собирает все .zip в каталоге. */
function findArchives(dir) {
  const found = [];
  if (!fs.existsSync(dir)) return found;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...findArchives(full));
    else if (/\.zip$/i.test(entry.name)) found.push(full);
  }
  return found;
}

/**
 * Разбирает каталог архивов.
 * @param {string} dir
 * @param {object} [opts] — { onProgress, laws }
 * @returns {{ records: object[], stats: object }}
 */
function ingestDirectory(dir, opts = {}) {
  const archives = findArchives(dir);
  const records = [];
  const stats = {
    archives: archives.length,
    xmlFiles: 0,
    parsed: 0,
    skipped: 0,
    failedArchives: [],
    failedDocuments: 0,
  };

  archives.forEach((archivePath, index) => {
    // путь относительно корня разбора, а не имя файла: в нём лежит признак
    // закона (data/fz223/...), по которому extract.js различает 44 и 223-ФЗ
    const archiveName = path.relative(dir, archivePath) || path.basename(archivePath);
    let buffer;
    try {
      buffer = fs.readFileSync(archivePath);
    } catch (err) {
      stats.failedArchives.push({ archive: archiveName, error: err.message });
      return;
    }

    try {
      for (const file of iterateFiles(buffer, (name) => /\.xml$/i.test(name))) {
        stats.xmlFiles += 1;
        try {
          const record = extractRecord(file.data.toString('utf8'), file.name, archiveName);
          if (record) {
            records.push(record);
            stats.parsed += 1;
          } else {
            stats.skipped += 1;
          }
        } catch {
          stats.failedDocuments += 1;
        }
      }
    } catch (err) {
      stats.failedArchives.push({ archive: archiveName, error: err.message });
    }

    if (opts.onProgress) opts.onProgress(index + 1, archives.length, archiveName);
  });

  return { records, stats };
}

/** Сохраняет записи в JSONL — чтобы не разбирать архивы повторно. */
function saveRecords(records, file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const stream = fs.createWriteStream(file, { encoding: 'utf8' });
  for (const record of records) stream.write(`${JSON.stringify(record)}\n`);
  stream.end();
  return new Promise((resolve, reject) => {
    stream.on('finish', resolve);
    stream.on('error', reject);
  });
}

function loadRecords(file) {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

module.exports = { ingestDirectory, findArchives, saveRecords, loadRecords };
