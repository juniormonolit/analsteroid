/**
 * Assert-скрипт: /rop — «РОП сегодня» (задача #6446), фильтрация состава по
 * зоне ответственности сессии — БЕЗ БД (тот же приём, что scripts/
 * assert-unsell-deal.ts: чистые функции тестируются напрямую).
 *
 * Проверяет три роли (deriveRopScope из features/tv/engine/access.ts):
 *  1. Руководство (супер-админ / «Администратор», tvScope().full === true) →
 *     RopScope.full, без ограничений — как раньше видело всё в «Телевизорах».
 *  2. РОП/Директор с подконтрольными отделами (tvScope().allowedDeptIds
 *     непустой) → тот же набор отделов, selfOnly не выставляется.
 *  3. Рядовой менеджер (МОП) без подконтрольных отделов → скоуп сужается до
 *     «только я» по bitrixUserId; без привязки к Битриксу — пустой скоуп
 *     (ни свои данные, ни тем более чужие).
 *
 * И саму фильтрацию состава (scopeRows из features/tv/engine/dashboard.ts) на
 * фикстуре из шести менеджеров в трёх отделах — для каждого из четырёх видов
 * скоупа выше, плюс регрессия: вызов БЕЗ scope (как делает публичный /today)
 * обязан возвращать состав не тронутым.
 *
 * Запуск: node --import ./scripts/ts-resolve-register.mjs scripts/assert-rop-scope.ts
 */
import { deriveRopScope, ropFullAccess, type RopScope } from '../features/tv/engine/access.ts';
import type { TvScope } from '../features/tv/engine/access.ts';
import { scopeRows } from '../features/tv/engine/dashboard.ts';
import type { OrgRow } from '../features/tv/engine/orgTree.ts';
import type { SessionUser } from '../lib/auth/session.ts';

let failures = 0;
let passed = 0;
function check(cond: boolean, label: string) {
  if (cond) { passed++; return; }
  failures++;
  console.error(`FAIL ${label}`);
}

// ── фикстура: 3 отдела, 6 менеджеров ─────────────────────────────────────────
const DEPT_MOSCOW = 'dept-moscow';
const DEPT_SPB = 'dept-spb';
const DEPT_KRD = 'dept-krd';

const rows: OrgRow[] = [
  { manager_id: '101', manager_name: 'Иванов', department_id: DEPT_MOSCOW, short_login: 'ivanov' },
  { manager_id: '102', manager_name: 'Петров', department_id: DEPT_MOSCOW, short_login: 'petrov' },
  { manager_id: '201', manager_name: 'Сидорова', department_id: DEPT_SPB, short_login: 'sidorova' },
  { manager_id: '202', manager_name: 'Кузнецов', department_id: DEPT_SPB, short_login: 'kuznecov' },
  { manager_id: '301', manager_name: 'Смирнов', department_id: DEPT_KRD, short_login: 'smirnov' },
  { manager_id: '999', manager_name: 'Без отдела', department_id: null, short_login: null },
];

// ── deriveRopScope: три роли ─────────────────────────────────────────────────

// Роль 1: руководство (Администратор/супер-админ) — hasFullManagerAccess уже даёт full.
const fullBase: TvScope = { allowedDeptIds: null, full: true };
const fullScope = deriveRopScope(fullBase, null);
check(fullScope.full === true && fullScope.allowedDeptIds === null && fullScope.selfOnly === null,
  'Роль «Администратор» (full tvScope) → RopScope.full без ограничений');

// Роль 2: РОП/Директор с подконтрольными отделами.
const deptBase: TvScope = { allowedDeptIds: new Set([DEPT_MOSCOW]), full: false };
const ropDeptScope = deriveRopScope(deptBase, '101');
check(ropDeptScope.full === false && !ropDeptScope.selfOnly
  && ropDeptScope.allowedDeptIds?.has(DEPT_MOSCOW) === true && ropDeptScope.allowedDeptIds?.size === 1,
  'Роль «РОП» со своим отделом (tvScope.allowedDeptIds непуст) → скоуп по отделам, не self-only');

// Роль 3: рядовой менеджер (МОП) без подконтрольных отделов.
const emptyBase: TvScope = { allowedDeptIds: new Set(), full: false };
const mopScope = deriveRopScope(emptyBase, '102');
check(mopScope.full === false && mopScope.selfOnly === '102' && mopScope.allowedDeptIds?.size === 0,
  'Роль «МОП» без подконтрольных отделов → селф-скоуп по своему bitrixUserId');

// Граница: тот же МОП, но аккаунт НЕ привязан к Битриксу — не должен получить «полный» доступ по умолчанию.
const unlinkedScope = deriveRopScope(emptyBase, null);
check(unlinkedScope.full === false && unlinkedScope.selfOnly === null && unlinkedScope.allowedDeptIds?.size === 0,
  'МОП без bitrixUserId и без отделов → пустой скоуп (не чужие данные, не полный доступ)');

// ── scopeRows: фильтрация состава по каждому из скоупов ─────────────────────

check(scopeRows(rows, undefined).length === rows.length,
  'без scope (путь /today) → состав не тронут, регрессия публичного дашборда');
check(scopeRows(rows, fullScope).length === rows.length,
  'full-скоуп руководства → видит все 6 строк, включая менеджера без отдела');

const ropView = scopeRows(rows, ropDeptScope);
check(ropView.length === 2 && ropView.every(r => r.department_id === DEPT_MOSCOW),
  'РОП своего отдела → видит только Москву (Иванов, Петров), не СПб и не Краснодар');

const mopView = scopeRows(rows, mopScope);
check(mopView.length === 1 && mopView[0].manager_id === '102',
  'МОП → видит строго одну строку, свою (Петров), не коллег по отделу');

const unlinkedView = scopeRows(rows, unlinkedScope);
check(unlinkedView.length === 0,
  'непривязанный аккаунт без отделов → пустой состав, не полный и не чужой');

// Директор «свой филиал» — та же ветка кода, что РОП (managedDepartmentIds уже
// включает филиал целиком), но с несколькими отделами — проверяем объединение.
const directorBase: TvScope = { allowedDeptIds: new Set([DEPT_SPB, DEPT_KRD]), full: false };
const directorScope = deriveRopScope(directorBase, null);
const directorView = scopeRows(rows, directorScope);
check(directorView.length === 3 && directorView.every(r => r.department_id === DEPT_SPB || r.department_id === DEPT_KRD),
  'Директор филиала (СПб + Краснодар) → видит оба отдела разом (3 менеджера), не Москву');

// ── ropFullAccess(): регрессия задачи #6479 (баг «все аккаунты видят все») ──
// На проде роль «Администратор» (джокер section.* в roles.permissions) носят
// не только дирекция, но и маркетолог, разработчик («Отдел развития») и
// тестовый аккаунт в «Отделе продаж» — реальная конфигурация, снятая
// READ-ONLY с прода (system) при разборе задачи. hasFullManagerAccess() (старая
// проверка) давала им ВСЮ компанию на /rop только по имени роли; ropFullAccess()
// обязана требовать ОТДЕЛЬНОЕ, явное право.
function fakeSession(overrides: Partial<SessionUser>): SessionUser {
  return {
    id: 'u1', login: 'u1', displayName: 'Тест', isSuperadmin: false,
    permissions: [], sectionOverrides: [], roleName: null, avatarUrl: null,
    bitrixUserId: null, uiMode: null, ...overrides,
  };
}

// Реальная прод-конфигурация: роль «Администратор» → permissions включают
// джокер «Все разделы» (section.*), но НЕ явное action.rop_today.full_access —
// именно так сегодня выглядят на проде marketolog1/sdd6/verifier и другие
// не-руководство аккаунты с ролью «Администратор».
const adminRoleNoExplicitGrant = fakeSession({ roleName: 'Администратор', permissions: ['section.*'] });
check(ropFullAccess(adminRoleNoExplicitGrant) === false,
  '#6479: роль «Администратор» (джокер section.*) БЕЗ явного action.rop_today.full_access → ropFullAccess=false (регрессия бага)');

// Тот же аккаунт без организационной привязки (bitrixUserId=null, как у
// реальных junior/devtest/test_alfred_admin на проде) — по новой логике должен
// получить ПУСТОЙ дашборд, не «всё».
const adminEffectiveScope = ropFullAccess(adminRoleNoExplicitGrant)
  ? { full: true, allowedDeptIds: null, selfOnly: null }
  : deriveRopScope({ allowedDeptIds: new Set(), full: false }, adminRoleNoExplicitGrant.bitrixUserId);
check(adminEffectiveScope.full === false && adminEffectiveScope.selfOnly === null
  && adminEffectiveScope.allowedDeptIds?.size === 0,
  '#6479: тот же аккаунт без bitrixUserId/подконтрольных отделов → пустой дашборд («нет привязки к оргструктуре»), не вся компания');
check(scopeRows(rows, adminEffectiveScope).length === 0,
  '#6479: scopeRows для этого скоупа → 0 строк, не все 6');

// Явный грант права — единственный способ получить full теперь.
const adminWithExplicitGrant = fakeSession({
  roleName: 'Администратор', permissions: ['section.*', 'action.rop_today.full_access'],
});
check(ropFullAccess(adminWithExplicitGrant) === true,
  '#6479: то же плюс явный action.rop_today.full_access → ropFullAccess=true');

// Супер-админ по-прежнему проходит без явного гранта — «не может залочить сам себя».
const superadmin = fakeSession({ isSuperadmin: true, roleName: 'Администратор', permissions: ['section.*'] });
check(ropFullAccess(superadmin) === true,
  '#6479: isSuperadmin=true → ropFullAccess=true и без явного action-права (супер-админ не блокируется)');

// РОП/Директор без нового права — как и раньше, ropFullAccess=false (не менялось,
// но фиксируем явно — раньше это тоже гарантировала hasFullManagerAccess).
const ropRole = fakeSession({ roleName: 'РОП', permissions: ['section.sales', 'section.plans'] });
check(ropFullAccess(ropRole) === false, '#6479: роль «РОП» без явного права → ropFullAccess=false');

console.log(`\n${passed} passed, ${failures} failed`);
if (failures > 0) process.exit(1);
