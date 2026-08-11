import { sys, sa, q } from './db.mjs';

try {
  console.log('═══ АНАЛИЗ ЭКОНОМИКИ MLT ═══\n');

  // Шаг 1: Сколько всего ручных операций, источники
  console.log('1. Типы источников в badge_coin_ledger:');
  const sources = await q(sys, `
    SELECT source, count(*) cnt, sum(amount) total_amount
      FROM badge_coin_ledger
     WHERE source IS NOT NULL
     GROUP BY source
     ORDER BY cnt DESC
  `);
  sources.forEach(s => {
    console.log(`   ${s.source}: ${s.cnt} шт, сумма ${s.total_amount}`);
  });

  // Определяем, какие источники = ручные
  const manualSources = new Set();
  for (const s of sources) {
    if (s.source !== 'badge_award' && s.source !== null) {
      manualSources.add(s.source);
    }
  }
  console.log(`\n   Ручные источники: ${Array.from(manualSources).join(', ')}`);

  // Шаг 2: Всего ручных операций
  console.log('\n2. РУЧНЫЕ ОПЕРАЦИИ И ШТРАФЫ:');
  const manualSourcesSQL = Array.from(manualSources).map(s => `'${s}'`).join(',');
  
  const manualTotal = await q(sys, `
    SELECT 
      count(*) cnt,
      sum(abs(amount)) total_abs,
      sum(case when amount > 0 then amount else 0 end) bonuses,
      sum(case when amount < 0 then abs(amount) else 0 end) penalties
    FROM badge_coin_ledger
    WHERE source IN (${manualSourcesSQL})
  `);
  
  const m = manualTotal[0];
  console.log(`   Всего операций: ${m.cnt}`);
  console.log(`   Начисления: ${m.bonuses || 0}`);
  console.log(`   Штрафы: ${m.penalties || 0}`);

  // Общая эмиссия для процента
  const emission = await q(sys, `
    SELECT 
      sum(case when amount > 0 then amount else 0 end) total
    FROM badge_coin_ledger
  `);
  const emissionTotal = emission[0].total || 1;
  const manualShare = Math.round((m.bonuses + m.penalties) / emissionTotal * 100);
  console.log(`   Доля от эмиссии: ${manualShare}%`);

  // Шаг 3: Кто раздаёт (actor_login)
  console.log('\n3. ТОП РАЗДАЮЩИХ (actor_login):');
  const topActors = await q(sys, `
    SELECT 
      actor_login,
      count(*) cnt,
      sum(case when amount > 0 then amount else 0 end) bonuses,
      sum(case when amount < 0 then abs(amount) else 0 end) penalties
    FROM badge_coin_ledger
    WHERE source IN (${manualSourcesSQL}) AND actor_login IS NOT NULL
    GROUP BY actor_login
    ORDER BY cnt DESC
    LIMIT 5
  `);
  
  topActors.forEach(a => {
    console.log(`   ${a.actor_login}: ${a.cnt} опер. (начисл. ${a.bonuses || 0}, штрафы ${a.penalties || 0})`);
  });

  // Шаг 4: Повторное начисление одному человеку одним актором
  console.log('\n4. ПОВТОРНЫЕ НАЧИСЛЕНИЯ (3+ раза от одного actor):');
  const repeated = await q(sys, `
    SELECT 
      actor_login,
      bitrix_id,
      count(*) cnt,
      sum(amount) total_amount
    FROM badge_coin_ledger
    WHERE source IN (${manualSourcesSQL}) AND actor_login IS NOT NULL
    GROUP BY actor_login, bitrix_id
    HAVING count(*) >= 3
    ORDER BY actor_login, cnt DESC
    LIMIT 15
  `);
  
  if (repeated.length > 0) {
    repeated.forEach(r => {
      console.log(`   ${r.actor_login} → bitrix_id ${r.bitrix_id}: ${r.cnt} раз, всего ${r.total_amount}`);
    });
  } else {
    console.log(`   Нет данных`);
  }

  // Шаг 5: Штрафы (отрицательные)
  console.log('\n5. ШТРАФЫ (отрицательные суммы):');
  const penalties = await q(sys, `
    SELECT 
      actor_login,
      count(*) cnt,
      sum(abs(amount)) total_penalty
    FROM badge_coin_ledger
    WHERE source IN (${manualSourcesSQL}) AND amount < 0
    GROUP BY actor_login
    ORDER BY total_penalty DESC
    LIMIT 5
  `);
  
  if (penalties.length > 0) {
    penalties.forEach(p => {
      console.log(`   ${p.actor_login}: ${p.cnt} штрафов на ${p.total_penalty}`);
    });
  } else {
    console.log(`   Нет штрафов`);
  }

  // Шаг 6: Подозрительное
  console.log('\n6. ПОДОЗРИТЕЛЬНОЕ:');
  
  // Без комментария
  const noComment = await q(sys, `
    SELECT count(*) cnt
    FROM badge_coin_ledger
    WHERE source IN (${manualSourcesSQL}) AND (comment IS NULL OR comment = '')
  `);
  console.log(`   а) Операций без комментария: ${noComment[0].cnt}`);
  
  // Круглые крупные суммы
  const roundBig = await q(sys, `
    SELECT count(*) cnt, sum(amount) total
    FROM badge_coin_ledger
    WHERE source IN (${manualSourcesSQL}) 
      AND amount > 0
      AND amount % 1000 = 0 
      AND amount >= 5000
  `);
  console.log(`   б) Круглые ≥5000: ${roundBig[0].cnt} шт на ${roundBig[0].total || 0}`);
  
  // Actor начислил сам себе (нужно сопоставить)
  console.log(`   в) Actor→сам себе: требует картографии bitrix_id↔login (не проверил)`);

  console.log('\n═══ КОНЕЦ ═══\n');
} catch (e) {
  console.error('Ошибка:', e.message);
} finally {
  await sys.end();
  await sa.end();
}
