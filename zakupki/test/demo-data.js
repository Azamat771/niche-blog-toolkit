'use strict';
/**
 * Генератор демонстрационного набора данных.
 *
 * Это СИНТЕТИКА, не настоящие закупки. Нужна, чтобы проверить, что инструмент
 * установлен и работает, и чтобы увидеть формат отчёта до выгрузки из ЕИС.
 */

const { makeZip, makeRandom, notificationXml, protocolXml, cancelXml } = require('./helpers');

const CUSTOMERS = [
  { name: 'МБОУ «СОШ №1» г. Орска', inn: '5613001234' },
  { name: 'МБДОУ «Детский сад №14» г. Бузулука', inn: '5603002345' },
  { name: 'ГБУЗ «Городская больница» г. Оренбурга', inn: '5610009999' },
  { name: 'Администрация Сакмарского района', inn: '5642000111' },
  { name: 'МУП «Благоустройство» г. Новотроицка', inn: '5607004321' },
  { name: 'ГАУ «Спортивная школа» г. Оренбурга', inn: '5610112233' },
];

/**
 * Профили ниш: zeroBidRate задаёт, насколько часто никто не подаёт заявку.
 * Значения подобраны так, чтобы в демо-отчёте были и «пустые», и конкурентные ниши.
 */
const PROFILES = [
  { object: 'Оказание услуг по уборке помещений', okpd: '81.21.10', price: [180000, 420000], zeroBidRate: 0.8, months: [1, 2, 12] },
  { object: 'Услуги по дератизации и дезинсекции помещений', okpd: '81.29.11', price: [45000, 120000], zeroBidRate: 0.75, months: [3, 9] },
  { object: 'Техническое обслуживание систем пожарной сигнализации', okpd: '80.20.10', price: [90000, 350000], zeroBidRate: 0.6, months: [1, 4, 10] },
  { object: 'Поставка канцелярских товаров', okpd: '17.23.13', price: [60000, 240000], zeroBidRate: 0.1, months: [2, 8] },
  { object: 'Поставка продуктов питания', okpd: '10.89.19', price: [150000, 580000], zeroBidRate: 0.05, months: [1, 5, 9] },
  { object: 'Текущий ремонт кровли здания', okpd: '43.91.19', price: [280000, 590000], zeroBidRate: 0.55, months: [5, 6, 7] },
  { object: 'Услуги по покосу травы и содержанию территории', okpd: '81.30.10', price: [70000, 300000], zeroBidRate: 0.7, months: [5, 6] },
  { object: 'Заправка и восстановление картриджей', okpd: '18.12.19', price: [30000, 95000], zeroBidRate: 0.35, months: [3, 11] },
  { object: 'Поставка спортивного инвентаря', okpd: '32.30.15', price: [110000, 480000], zeroBidRate: 0.2, months: [4, 10] },
];

/**
 * Собирает демонстрационный архив.
 * @param {object} [opts] — { years, seed, currentDate }
 * @returns {{ zip: Buffer, documents: number }}
 */
function buildDemoArchive(opts = {}) {
  const years = opts.years || [2021, 2022, 2023, 2024, 2025, 2026];
  const currentDate = opts.currentDate || '2026-08-16';
  const currentYear = Number(currentDate.slice(0, 4));
  const cutoffMonth = Number(currentDate.slice(5, 7));
  const random = makeRandom(opts.seed || 20260816);

  const docs = [];
  let seq = 0;
  const nextNumber = () => `01533000121${String(20000000 + (seq += 1)).padStart(9, '0')}`;
  const pad = (n) => String(n).padStart(2, '0');

  for (const year of years) {
    for (const profile of PROFILES) {
      for (const month of profile.months) {
        // текущий год оборван по дате расчёта — как в реальной выгрузке
        if (year === currentYear && month > cutoffMonth) continue;

        const customer = CUSTOMERS[Math.floor(random() * CUSTOMERS.length)];
        const failed = random() < profile.zeroBidRate;
        const price = Math.round(
          profile.price[0] + random() * (profile.price[1] - profile.price[0])
        );

        // цепочка переобъявлений: провал → повтор через месяц, до 3 попыток
        let attempt = 0;
        let attemptFailed = failed;
        let attemptMonth = month;

        do {
          const number = nextNumber();
          const day = 5 + Math.floor(random() * 15);
          const publishDate = `${year}-${pad(attemptMonth)}-${pad(day)}`;

          docs.push({
            name: `notification_${number}.xml`,
            data: notificationXml({
              number,
              object: profile.object,
              customer: customer.name,
              inn: customer.inn,
              // при переобъявлении заказчик обычно поднимает цену
              price: String(price + attempt * Math.round(price * 0.08)),
              date: publishDate,
              okpd: profile.okpd,
            }),
          });

          const resultDay = Math.min(day + 12, 28);
          const resultDate = `${year}-${pad(attemptMonth)}-${pad(resultDay)}`;

          if (attemptFailed) {
            docs.push({
              name: `protocol_${number}.xml`,
              data: protocolXml({ number, date: resultDate, kind: 'NO_BIDS' }),
            });
          } else if (random() < 0.12) {
            docs.push({
              name: `notificationCancel_${number}.xml`,
              data: cancelXml({ number, date: resultDate }),
            });
          } else if (random() < 0.2) {
            docs.push({
              name: `protocol_${number}.xml`,
              data: protocolXml({ number, date: resultDate, kind: 'SINGLE_BID' }),
            });
          } else {
            docs.push({
              name: `protocol_${number}.xml`,
              data: protocolXml({ number, date: resultDate, kind: 'COMPLETED' }),
            });
          }

          attempt += 1;
          attemptMonth += 1;
          // повторяем, пока предыдущая попытка провалилась и год не кончился
          attemptFailed = attemptFailed && random() < 0.7;
        } while (
          attemptFailed &&
          attempt < 3 &&
          attemptMonth <= 12 &&
          !(year === currentYear && attemptMonth > cutoffMonth)
        );
      }
    }
  }

  return { zip: makeZip(docs), documents: docs.length };
}

module.exports = { buildDemoArchive, PROFILES, CUSTOMERS };
