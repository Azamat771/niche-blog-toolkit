'use strict';
/**
 * Тестовые помощники: сборка ZIP-архивов и генерация XML в стиле ЕИС.
 * Нужны, чтобы прогонять всю цепочку офлайн, без обращения к zakupki.gov.ru.
 */

const zlib = require('zlib');

/**
 * Собирает ZIP-архив из файлов в памяти.
 * CRC не считаем — ридер его не проверяет, а тестам достаточно структуры.
 */
function makeZip(files) {
  const local = [];
  const central = [];
  let offset = 0;

  for (const file of files) {
    const nameBuf = Buffer.from(file.name, 'utf8');
    const raw = Buffer.isBuffer(file.data) ? file.data : Buffer.from(file.data, 'utf8');
    const method = file.store ? 0 : 8;
    const compressed = method === 0 ? raw : zlib.deflateRawSync(raw);

    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x800, 6); // имена в UTF-8
    header.writeUInt16LE(method, 8);
    header.writeUInt32LE(0, 14); // crc
    header.writeUInt32LE(compressed.length, 18);
    header.writeUInt32LE(raw.length, 22);
    header.writeUInt16LE(nameBuf.length, 26);
    local.push(header, nameBuf, compressed);

    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(0x800, 8);
    entry.writeUInt16LE(method, 10);
    entry.writeUInt32LE(0, 16); // crc
    entry.writeUInt32LE(compressed.length, 20);
    entry.writeUInt32LE(raw.length, 24);
    entry.writeUInt16LE(nameBuf.length, 28);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, nameBuf);

    offset += header.length + nameBuf.length + compressed.length;
  }

  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);

  return Buffer.concat([...local, centralBuf, eocd]);
}

/** Детерминированный генератор — тесты не должны «плавать». */
function makeRandom(seed = 42) {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648;
  };
}

const NS = 'xmlns:ns2="http://zakupki.gov.ru/oos/export/1"';

function notificationXml({
  number, object, customer, inn, price, date, okpd, placingWay = 'Электронный аукцион', extraSum,
}) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<ns2:export ${NS}>
  <ns2:fcsNotificationEF schemeVersion="10.2">
    <purchaseNumber>${number}</purchaseNumber>
    <docPublishDate>${date}T09:00:00+05:00</docPublishDate>
    <purchaseObjectInfo>${object}</purchaseObjectInfo>
    <placingWay><name>${placingWay}</name></placingWay>
    <ETP><name>РТС-тендер</name></ETP>
    <purchaseResponsible>
      <responsibleOrg>
        <regNum>01533000121</regNum>
        <fullName>${customer}</fullName>
        <INN>${inn}</INN>
      </responsibleOrg>
    </purchaseResponsible>
    ${extraSum ? `<planInfo><sum>${extraSum}</sum></planInfo>` : ''}
    <lot>
      <maxPrice>${price}</maxPrice>
      <currency><code>RUB</code></currency>
      <purchaseObjects>
        <purchaseObject>
          <OKPD2><code>${okpd}</code><name>Позиция номенклатуры</name></OKPD2>
        </purchaseObject>
      </purchaseObjects>
    </lot>
  </ns2:fcsNotificationEF>
</ns2:export>`;
}

const PROTOCOL_REASONS = {
  NO_BIDS: 'По окончании срока подачи заявок не подано ни одной заявки на участие в электронном аукционе',
  SINGLE_BID: 'По окончании срока подачи заявок подана только одна заявка на участие',
  ALL_REJECTED: 'Все заявки на участие отклонены комиссией заказчика',
  COMPLETED: 'Победителем электронного аукциона признан участник с идентификационным номером 3',
};

/**
 * Протокол. Состоявшаяся закупка описывается через сведения о победителе,
 * несостоявшаяся — через abandonedReason. Раскладка важна: если завернуть
 * победителя в abandonedReason, классификатор справедливо сочтёт закупку
 * несостоявшейся, и фикстура будет проверять не то, что нужно.
 */
function protocolXml({ number, date, kind }) {
  const body = kind === 'COMPLETED'
    ? `<protocolLot>
      <applications>
        <application>
          <winnerIndication>true</winnerIndication>
          <resultInfo><name>${PROTOCOL_REASONS.COMPLETED}</name></resultInfo>
        </application>
      </applications>
    </protocolLot>`
    : `<protocolLot>
      <abandonedReason><name>${PROTOCOL_REASONS[kind]}</name></abandonedReason>
    </protocolLot>`;

  return `<?xml version="1.0" encoding="UTF-8"?>
<ns2:export ${NS}>
  <ns2:fcsProtocolEF schemeVersion="10.2">
    <purchaseNumber>${number}</purchaseNumber>
    <docPublishDate>${date}T15:00:00+05:00</docPublishDate>
    ${body}
  </ns2:fcsProtocolEF>
</ns2:export>`;
}

function cancelXml({ number, date, reason = 'Отмена закупки в связи с сокращением лимитов бюджетных обязательств' }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<ns2:export ${NS}>
  <ns2:fcsNotificationCancel schemeVersion="10.2">
    <purchaseNumber>${number}</purchaseNumber>
    <docPublishDate>${date}T12:00:00+05:00</docPublishDate>
    <cancelReason>${reason}</cancelReason>
  </ns2:fcsNotificationCancel>
</ns2:export>`;
}

module.exports = { makeZip, makeRandom, notificationXml, protocolXml, cancelXml, PROTOCOL_REASONS };
