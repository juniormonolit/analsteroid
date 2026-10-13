/**
 * Assert-скрипт: пилот «Канбан РОПа» (задача #9625) — доступ и конфиг колонок, БЕЗ БД.
 *  1. hasRopKanbanPilot: открывается ТОЛЬКО явным ключом section.rop_kanban_pilot —
 *     не джокером section.*, не супер-админом, не соседним ключом (section.rop_today).
 *  2. Ключ есть в каталоге PERM_SECTIONS, поэтому переживает сохранение оверрайдов
 *     (sanitizeSectionOverrides), а не стирается при правке пользователя в админке.
 *  3. Конфиг колонок: уникальные ключи, наборы стадий не пересекаются там, где в Битриксе
 *     они взаимоисключающие (Продано / Бронь / Цена дешевле / Запрос логисту / Необработанные).
 *
 * Запуск: npm run test:rop-kanban
 */
import { ALL_SECTIONS_PERM, hasPerm, hasRopKanbanPilot, sanitizeSectionOverrides } from '../lib/auth/perms.ts';
import type { SessionUser } from '../lib/auth/session.ts';
import {
  BETTER_PRICE_STAGES, COLUMNS, LOGIST_REQUEST_STAGES, RESERVED_STAGES, SALE_STAGES, UNPROCESSED_STAGES,
} from '../features/rop-kanban/engine/config.ts';

let failures = 0;
let passed = 0;
function check(cond: boolean, label: string) {
  if (cond) { passed++; console.log(`  ok   ${label}`); } else { failures++; console.error(`  FAIL ${label}`); }
}
const sess = (permissions: string[], isSuperadmin = false) =>
  ({ id: 'x', login: 'x', displayName: 'x', isSuperadmin, permissions, sectionOverrides: [], roleName: null, avatarUrl: null, bitrixUserId: null, uiMode: null }) as SessionUser;

console.log('hasRopKanbanPilot');
check(hasRopKanbanPilot(null) === false, 'нет сессии → нет доступа');
check(hasRopKanbanPilot(sess(['section.rop_kanban_pilot'])) === true, 'явный ключ (оверрайд) → доступ');
check(hasRopKanbanPilot(sess([ALL_SECTIONS_PERM])) === false, 'джокер section.* (роль «Администратор») → НЕТ доступа');
check(hasPerm(sess([ALL_SECTIONS_PERM]), 'section.rop_kanban_pilot') === true, '(контроль) обычный hasPerm джокер пропустил бы — поэтому нужен hasRopKanbanPilot');
check(hasRopKanbanPilot(sess([], true)) === false, 'супер-админ без оверрайда → НЕТ доступа');
check(hasRopKanbanPilot(sess([], true).isSuperadmin ? sess(['section.rop_kanban_pilot'], true) : null) === true, 'супер-админ С оверрайдом → доступ');
check(hasRopKanbanPilot(sess(['section.rop_today', 'action.rop_today.full_access'])) === false, 'доступ к /rop и full_access не открывают пилот');

console.log('каталог и оверрайды');
check(sanitizeSectionOverrides(['section.rop_kanban_pilot', 'мусор']).join() === 'section.rop_kanban_pilot', 'ключ переживает sanitizeSectionOverrides');

console.log('конфиг колонок');
const keys = COLUMNS.map(c => c.key);
check(new Set(keys).size === keys.length, 'ключи колонок уникальны');
check(COLUMNS.length === 15, `15 колонок первой партии (есть ${COLUMNS.length})`);
const overlap = (a: readonly string[], b: readonly string[]) => a.some(x => b.includes(x));
check(!overlap(SALE_STAGES, RESERVED_STAGES), 'Продано ∩ Бронь = ∅');
check(!overlap(BETTER_PRICE_STAGES, LOGIST_REQUEST_STAGES), 'Цена дешевле ∩ Запрос логисту = ∅');
check(!overlap(UNPROCESSED_STAGES, [...SALE_STAGES, ...RESERVED_STAGES, ...BETTER_PRICE_STAGES, ...LOGIST_REQUEST_STAGES]), 'Необработанные не пересекаются с прочими');
check(SALE_STAGES.length === 4 && RESERVED_STAGES.length === 4 && BETTER_PRICE_STAGES.length === 4 && LOGIST_REQUEST_STAGES.length === 4, 'по одной стадии на каждую из 4 воронок');

console.log(`\n${passed} ok, ${failures} fail`);
process.exit(failures ? 1 : 0);
