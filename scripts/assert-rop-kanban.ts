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
  BETTER_PRICE_STAGES, COLUMNS, CYCLES, CYCLE_ALL, LOGIST_REQUEST_STAGES, RESERVED_STAGES, SALE_STAGES, UNPROCESSED_STAGES,
  columnsForCycle, currentCycleByTime, parseCycleParam,
} from '../features/rop-kanban/engine/config.ts';
import { sanitizeDisabledCycles } from '../features/rop-kanban/engine/cycles.ts';

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
check(COLUMNS.length === 29, `29 колонок (есть ${COLUMNS.length})`);
check(COLUMNS.filter(c => c.computed).length === 15 && COLUMNS.filter(c => !c.computed && c.missing).length === 14, '15 считаются, 14 стоят пустыми с причиной');
const overlap = (a: readonly string[], b: readonly string[]) => a.some(x => b.includes(x));
check(!overlap(SALE_STAGES, RESERVED_STAGES), 'Продано ∩ Бронь = ∅');
check(!overlap(BETTER_PRICE_STAGES, LOGIST_REQUEST_STAGES), 'Цена дешевле ∩ Запрос логисту = ∅');
check(!overlap(UNPROCESSED_STAGES, [...SALE_STAGES, ...RESERVED_STAGES, ...BETTER_PRICE_STAGES, ...LOGIST_REQUEST_STAGES]), 'Необработанные не пересекаются с прочими');
check(SALE_STAGES.length === 4 && RESERVED_STAGES.length === 4 && BETTER_PRICE_STAGES.length === 4 && LOGIST_REQUEST_STAGES.length === 4, 'по одной стадии на каждую из 4 воронок');

// Эталон — SalesKanbanConfig::getColumns('default') Битрикса (MLT-IT/crm, master, 13.10.2026): порядок, название, цикл.
console.log('конфиг = SalesKanbanConfig.php');
const PHP: Array<[string, string, string | null]> = [
  ['unprocessedDeals', 'Необработанные', null], ['noActivities', 'Без дел', null],
  ['reservedWithActivitiesForToday', 'Брони с делами на сегодня', 'ONE'], ['confirmedReservedWithActivitiesForToday', 'Подтв. брони с делами на сегодня', 'ONE'],
  ['betterPrice', 'Есть цена дешевле', null], ['logistRequest', 'Запрос логисту', null], ['shipmentToday', 'Продано, отгружается сегодня', 'END'],
  ['logistNotAnswered', 'Логист не ответил', null], ['withBigDealsTasks', 'Большие сделки', 'OTHER'], ['stageCalled', 'Созвонился и озвучил', 'TWO'],
  ['repeatedSaleImportant', 'Выйти на повторную продажу', 'TWO'], ['unprocessedSecondary', 'Необработанные повторные', 'THREE'],
  ['regularClients', 'Постоянные клиенты', 'TWO'], ['stageCalledLowPriority', 'Созвонился и озвучил', 'THREE'], ['secondaryToday', 'Повторные на сегодня', 'THREE'],
  ['shipmentTomorrow', 'Продано, отгружается завтра', 'ONE,THREE'], ['withRepeatingDealsTasks', 'Повторные сделки', 'THREE'], ['debtTasks', 'Клиенты Долги', 'END'],
  ['callerIssuesTasks', 'Проблемы коллеры', 'END'], ['newDeals', 'Созданы сегодня', 'TWO,THREE'], ['noProducts', 'Без товаров', 'END'],
  ['withExpiredActivities', 'С просроченными делами', 'END'], ['withActivitiesForToday', 'С делами на сегодня', 'END'], ['withTasksOnControl', 'Ответ логиста не принят', 'END'],
  ['failedToday', 'Отказы за сегодня', 'OTHER'], ['failedFromSaleToday', 'Отказы из продаж (сегодня)', 'OTHER'], ['failedFromSaleThisWeek', 'Отказы из продаж (7 дней)', 'OTHER'],
  ['allSales', 'Все продажи', 'OTHER'], ['updTasks', 'Клиенты УПД', null],
];
check(PHP.every(([k, t, cy], i) => COLUMNS[i]?.key === k && COLUMNS[i].title === t && (COLUMNS[i].cycle?.join(',') ?? null) === cy), 'порядок, названия и циклы всех 29 колонок совпадают построчно');
check(CYCLES.map(c => c.key).join() === 'ONE,TWO,THREE,END,OTHER', '5 циклов в порядке Битрикса');

console.log('циклы');
const cnt = (k: string) => columnsForCycle(k as never).length;
check(cnt('ONE') === 6 + 3 && cnt('TWO') === 6 + 4 && cnt('THREE') === 6 + 6 && cnt('END') === 6 + 7 && cnt('OTHER') === 6 + 5, 'колонок по вкладкам: «всегда»(6) + цикл (3/4/6/7/5)');
check(cnt(CYCLE_ALL) === 29, 'режим ALL — все 29');
check(columnsForCycle('ONE').some(c => c.key === 'shipmentTomorrow') && columnsForCycle('THREE').some(c => c.key === 'shipmentTomorrow') && !columnsForCycle('TWO').some(c => c.key === 'shipmentTomorrow'), 'колонка с двумя циклами видна в обоих и только в них');
check(columnsForCycle('OTHER').filter(c => !c.cycle).length === 6, '«всегда» видны в любой вкладке');
const msk = (h: number, m: number) => new Date(Date.UTC(2026, 9, 13, h - 3, m)); // МСК = UTC+3
check(currentCycleByTime(msk(9, 0)) === 'ONE' && currentCycleByTime(msk(11, 59)) === 'ONE', 'до 12:00 — 1 цикл');
check(currentCycleByTime(msk(12, 0)) === 'TWO' && currentCycleByTime(msk(15, 59)) === 'TWO', '12:00–16:00 — 2 цикл');
check(currentCycleByTime(msk(16, 0)) === 'THREE' && currentCycleByTime(msk(17, 29)) === 'THREE', '16:00–17:30 — 3 цикл');
check(currentCycleByTime(msk(17, 30)) === 'END' && currentCycleByTime(msk(23, 0)) === 'END', 'с 17:30 — 4 цикл');
check(currentCycleByTime(new Date(Date.UTC(2026, 9, 13, 20, 59))) === 'END' && currentCycleByTime(new Date(Date.UTC(2026, 9, 13, 21, 0))) === 'ONE', 'полночь МСК (21:00 UTC) — снова 1 цикл');
check(parseCycleParam('TWO') === 'TWO' && parseCycleParam('ALL') === 'ALL' && parseCycleParam('xx') === null && parseCycleParam(null) === null, 'parseCycleParam принимает только известные ключи');

console.log('галочки менеджер × цикл');
check(sanitizeDisabledCycles(['END', 'ONE', 'ONE', 'мусор', 5]).join() === 'ONE,END', 'sanitize: дубли и мусор убраны, порядок циклов');
check(sanitizeDisabledCycles(['ALL']).length === 0, 'ALL не может быть выключенным циклом');
check(sanitizeDisabledCycles(undefined).length === 0 && sanitizeDisabledCycles('ONE').length === 0, 'не массив → пусто (все циклы включены)');

console.log(`\n${passed} ok, ${failures} fail`);
process.exit(failures ? 1 : 0);
