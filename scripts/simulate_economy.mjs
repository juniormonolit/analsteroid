// Симуляция года экономики MLT (запрос владельца 06.08): «смоделируй год с июля
// 2025 по июль 2026 — как бы начислялись и тратились баллы, если бы в магазине
// были товары под любой кошелёк, часть нематериальных, если бы РОП периодически
// штрафовал и поощрял; учти TTL и текучку».
//
// ЧТО БЕРЁМ ИЗ ФАКТА, А ЧТО МОДЕЛИРУЕМ (важно для доверия к цифрам):
//   ФАКТ  — персональный темп начислений каждого менеджера: суммы наград за
//           окно работы движка (03.04.2026 → сегодня) ÷ месяцы окна.
//   МОДЕЛЬ — поведение: доля баланса, которую человек тратит за месяц; ручные
//           поощрения/штрафы РОПа; текучка. Реальных данных по ним нет (магазин
//           пуст, ручных операций почти не было) — поэтому это СЦЕНАРИИ, а не
//           предсказание. Каждое допущение named-константой ниже.
//
// Запуск: npx tsx scripts/simulate_economy.mjs

import { readFileSync } from 'fs';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { Pool } = require('pg');

const env = {};
for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
  const m = line.match(/^([A-Z_0-9]+)=(.*)$/);
  if (m) env[m[1]] = m[2].replace(/\\\$/g, '$').replace(/^"|"$/g, '');
}

const MONTHS = 12;
const RATE_RUB = 5;              // ₽ за 1 MLT — решение владельца 06.08
const COVERAGE_MONTHS = 4.1;     // окно работы движка, по которому берём темп

// ── Допущения поведения (МОДЕЛЬ) ────────────────────────────────────────────
// Доля СТАРЫХ лотов, которые человек тратит за месяц, когда в магазине есть
// товары «под любой кошелёк». Три сценария: скупой / обычный / азартный.
const SPEND_SCENARIOS = { 'скупой': 0.15, 'обычный': 0.35, 'азартный': 0.6 };
// Ручные операции РОПа: доля людей в месяц и размер относительно месячного темпа.
const BONUS_SHARE = 0.10, BONUS_MULT = 0.5;    // 10% людей получают +50% темпа
const PENALTY_SHARE = 0.08, PENALTY_MULT = 0.4; // 8% штрафуются на 40% темпа
// Текучка: доля состава, уходящая за год (владелец: «точно не знаем, но есть
// среди относительно новеньких»). Новичок приходит с нулём и низким темпом.
const CHURN_YEAR = 0.15;
const NEWCOMER_RATE_FACTOR = 0.4;

const sys = new Pool({
  host: env.YC_PG_HOST, port: Number(env.YC_PG_PORT), user: env.YC_PG_USER,
  password: env.YC_PG_PASSWORD, database: 'system',
  ssl: { ca: readFileSync(env.YC_PG_SSL_CA_PATH, 'utf8'), rejectUnauthorized: false }, max: 1,
});

const rows = (await sys.query(`
  SELECT a.bitrix_id::text id, sum(l.amount)::int mlt
    FROM badge_coin_ledger l JOIN badge_awards a ON a.id = l.badge_award_id
   WHERE l.amount > 0
     AND COALESCE(NULLIF(a.period_date, '2000-01-01'), a.awarded_at::date) >= '2026-04-03'
   GROUP BY 1`)).rows;
await sys.end();

const people = rows.map(r => ({ rate: r.mlt / COVERAGE_MONTHS })).filter(p => p.rate > 0);
const totalRate = people.reduce((s, p) => s + p.rate, 0);
console.log(`Состав: ${people.length} человек, суммарный темп ${Math.round(totalRate).toLocaleString('ru-RU')} MLT/мес`);
console.log(`(это ФАКТ по движку; поведение ниже — модель)\n`);

// Детерминированный «псевдослучай»: одинаковый результат при каждом запуске —
// иначе сценарии нельзя сравнивать между собой.
let seed = 42;
const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };

function simulate(ttlMonths, spendRate) {
  // Кошелёк = очередь лотов [{ mlt, age }], сгорание FIFO по TTL.
  const wallets = people.map(p => ({ rate: p.rate, lots: [], tenure: 12 }));
  let emitted = 0, spentMaterial = 0, spentImmaterial = 0, burned = 0, penalties = 0, bonuses = 0, churned = 0;

  for (let month = 0; month < MONTHS; month++) {
    for (const w of wallets) {
      // Текучка: часть людей уходит, на их место приходит новичок с нулём.
      if (rnd() < CHURN_YEAR / MONTHS) {
        churned++;
        w.lots = [];                       // баланс ушедшего аннулируется
        w.rate = w.rate * NEWCOMER_RATE_FACTOR;
        w.tenure = 0;
      }
      w.tenure++;

      // 1. Начисление за месяц (+ ручные операции РОПа)
      let inc = w.rate;
      if (rnd() < BONUS_SHARE) { const b = w.rate * BONUS_MULT; inc += b; bonuses += b; }
      emitted += inc;
      w.lots.push({ mlt: inc, age: 0 });

      // 2. Штраф — списывается с самых старых лотов
      if (rnd() < PENALTY_SHARE) {
        let need = w.rate * PENALTY_MULT;
        penalties += need;
        while (need > 0 && w.lots.length) {
          const lot = w.lots[0];
          const take = Math.min(lot.mlt, need);
          lot.mlt -= take; need -= take;
          if (lot.mlt <= 0.01) w.lots.shift();
        }
      }

      // 3. Траты: человек тратит долю баланса; 60% уходит в материальное
      //    (компания реально платит), 40% в нематериальное (отгул, поздний
      //    старт — стоит рабочего времени, а не денег).
      const balance = w.lots.reduce((s, l) => s + l.mlt, 0);
      let spend = balance * spendRate;
      spentMaterial += spend * 0.6;
      spentImmaterial += spend * 0.4;
      while (spend > 0 && w.lots.length) {
        const lot = w.lots[0];
        const take = Math.min(lot.mlt, spend);
        lot.mlt -= take; spend -= take;
        if (lot.mlt <= 0.01) w.lots.shift();
      }

      // 4. Старение и сгорание по TTL
      for (const l of w.lots) l.age++;
      const alive = [];
      for (const l of w.lots) { if (l.age >= ttlMonths) burned += l.mlt; else alive.push(l); }
      w.lots = alive;
    }
  }

  const onHand = wallets.reduce((s, w) => s + w.lots.reduce((a, l) => a + l.mlt, 0), 0);
  const best = Math.max(...wallets.map(w => w.lots.reduce((a, l) => a + l.mlt, 0)));
  return { emitted, spentMaterial, spentImmaterial, burned, onHand, penalties, bonuses, churned, best };
}

const f = (v) => Math.round(v).toLocaleString('ru-RU');
const rub = (v) => `${Math.round(v * RATE_RUB).toLocaleString('ru-RU')} ₽`;

for (const ttl of [6, 12]) {
  console.log(`\n══════ СРОК ЖИЗНИ ${ttl} МЕС ══════`);
  const table = [];
  for (const [name, sr] of Object.entries(SPEND_SCENARIOS)) {
    const r = simulate(ttl, sr);
    table.push({
      'сценарий трат': name,
      'начислено': f(r.emitted),
      'потрачено (мат.)': f(r.spentMaterial),
      'нематер.': f(r.spentImmaterial),
      'сгорело': f(r.burned),
      'на руках': f(r.onHand),
      'сгорело %': Math.round(r.burned / r.emitted * 100) + '%',
      'реальные ₽/мес': f(r.spentMaterial * RATE_RUB / MONTHS),
      'макс. накопил': f(r.best),
    });
  }
  console.table(table);
}

// Сколько стоит компании год при каждом сценарии + доступность айфона
console.log('\n══════ ВЫВОДЫ ══════');
for (const ttl of [6, 12]) {
  for (const [name, sr] of Object.entries(SPEND_SCENARIOS)) {
    const r = simulate(ttl, sr);
    console.log(`TTL ${ttl} мес · ${name.padEnd(9)} → эмиссия ${rub(r.emitted)}/год, реальные траты ${rub(r.spentMaterial)}/год (${f(r.spentMaterial * RATE_RUB / MONTHS)} ₽/мес), максимум на руках ${f(r.best)} MLT = ${rub(r.best)}`);
  }
}
console.log(`\nАйфон при курсе ${RATE_RUB} ₽ стоит ${f(150000 / RATE_RUB)} MLT`);
console.log(`Текучка в модели: ${Math.round(CHURN_YEAR * 100)}%/год, новичок стартует с нуля и темпом ${NEWCOMER_RATE_FACTOR * 100}% от среднего`);
