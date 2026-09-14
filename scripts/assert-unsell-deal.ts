/**
 * Assert-скрипт: «Снять с продажи» (задача #6260) — permission-гейт и
 * стадийный гард, БЕЗ БД (тот же приём, что scripts/assert-report-engine.ts:
 * чистые функции lib/sales/unsellDeal.ts тестируются напрямую).
 *
 * Проверяет:
 *  1. canUnsellDeal — РОП без явного права НЕ проходит, супер-админ и
 *     «Администратор» проходят всегда, роль с явным action.deals.unsell
 *     (паттерн «Директор» + выданное право) проходит, пустая сессия — нет.
 *  2. checkUnsellable — сделка в стадии sold/shipped отклоняется с понятной
 *     причиной, сделка с пустым sold_at отклоняется («снимать нечего»),
 *     обычная рабочая стадия — разрешена.
 *
 * Запуск: node --import ./scripts/ts-resolve-register.mjs scripts/assert-unsell-deal.ts
 */
import { canUnsellDeal, checkUnsellable } from '../lib/sales/unsellDeal.ts';
import type { SessionUser } from '../lib/auth/session.ts';

let failures = 0;
let passed = 0;
function check(cond: boolean, label: string) {
  if (cond) { passed++; return; }
  failures++;
  console.error(`FAIL ${label}`);
}

function user(over: Partial<SessionUser>): SessionUser {
  return {
    id: 'u1', login: 'test', displayName: 'Тест', isSuperadmin: false,
    permissions: [], sectionOverrides: [], roleName: null, avatarUrl: null,
    bitrixUserId: null, uiMode: null,
    ...over,
  };
}

// ── canUnsellDeal ───────────────────────────────────────────────────────────
check(canUnsellDeal(null) === false, 'нет сессии → нет доступа');

check(
  canUnsellDeal(user({ roleName: 'РОП', permissions: [] })) === false,
  'РОП без явного права → 403 (нет доступа)',
);
check(
  canUnsellDeal(user({ roleName: 'РОП', permissions: ['section.plans', 'section.summary'] })) === false,
  'РОП с другими правами, но без action.deals.unsell → нет доступа',
);
check(
  canUnsellDeal(user({ roleName: 'МОП', permissions: [] })) === false,
  'МОП → нет доступа',
);

check(
  canUnsellDeal(user({ isSuperadmin: true, roleName: null })) === true,
  'супер-админ → всегда доступ',
);
check(
  canUnsellDeal(user({ roleName: 'Администратор', permissions: [] })) === true,
  '«Администратор» → всегда доступ (hasFullManagerAccess), даже без явного права',
);

check(
  canUnsellDeal(user({ roleName: 'Директор', permissions: ['action.deals.unsell'] })) === true,
  'Директор с выданным правом action.deals.unsell → доступ',
);
check(
  canUnsellDeal(user({ roleName: 'Директор', permissions: [] })) === false,
  'Директор БЕЗ выданного права → нет доступа (дефолт закрыт, выдаётся явно в матрице)',
);
check(
  canUnsellDeal(user({ roleName: 'Собственник', permissions: ['action.deals.unsell'] })) === true,
  'любая роль «выше директора» с выданным правом → доступ (право не привязано к конкретному имени роли)',
);

// ── checkUnsellable ──────────────────────────────────────────────────────────
check(
  checkUnsellable({ sold_at: '2026-09-01T10:00:00Z', stage_event_type: 'confirmed', stage_name: 'Согласован' }).ok === true,
  'рабочая стадия (confirmed), sold_at заполнен → можно снимать',
);
check(
  checkUnsellable({ sold_at: null, stage_event_type: 'confirmed', stage_name: 'Согласован' }).ok === false,
  'sold_at уже пуст → отказ («снимать нечего»)',
);

const soldGuard = checkUnsellable({ sold_at: '2026-09-01T10:00:00Z', stage_event_type: 'sold', stage_name: 'Продано (ЧЛ)' });
check(soldGuard.ok === false, 'стадия sold → отказ');
check(!soldGuard.ok && soldGuard.reason.includes('Продано (ЧЛ)'), 'отказ по stage=sold называет текущую стадию в причине');

const shippedGuard = checkUnsellable({ sold_at: '2026-09-01T10:00:00Z', stage_event_type: 'shipped', stage_name: 'Отгружено' });
check(shippedGuard.ok === false, 'стадия shipped (отгружено) → тоже отказ');

console.log(`\n${passed} passed, ${failures} failed`);
if (failures > 0) process.exit(1);
