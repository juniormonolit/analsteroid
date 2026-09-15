/**
 * Assert-скрипт: раскрытие «Продажи»/«Брони» в список сделок на /today и /rop
 * (задача #6465) — БЕЗ БД (тот же приём, что scripts/assert-rop-scope.ts): чистые
 * функции тестируются на фикстуре уже посчитанного TvDashboard.
 *
 * Проверяет:
 *  1. resolveDrilldownSelection по id узла (в т.ч. вложенного) — возвращает ровно
 *     allManagerIds этого узла и его имя (та же связка, что дала node.salesCount/
 *     bookCount в карточке — сумма списка сделок физически не может разойтись).
 *  2. resolveDrilldownSelection по id менеджера — один id + имя из managers{}.
 *  3. Узел вне дерева (не существует ИЛИ отвалился build()'ом как узел с
 *     managerCount=0 — ровно то, что происходит с узлом полностью вне scope
 *     /rop) → null, а не пустой/угаданный список.
 *  4. Менеджер, которого нет в managers{} (вне scope /rop — buildDashboard() не
 *     кладёт туда менеджеров вне scopeRows()) → null, а не «мимо кассы» с 0.
 *  5. dateColumnFor/funnelConditionFor — текст условия для 'sales'/'book' совпадает
 *     с тем, что задаёт каталог метрик (primary/repeat_sales_count: date_field=
 *     sold_at, filters=funnel_type primary|repeat; reservations_count: date_field=
 *     reserved_at, filters=[]) — если кто-то поправит SQL и забудет про сумму
 *     карточки, тест это заметит раньше QA.
 *
 * Запуск: node --experimental-strip-types --import ./scripts/ts-resolve-register.mjs scripts/assert-dashboard-drilldown.ts
 */
import { resolveDrilldownSelection, dateColumnFor, funnelConditionFor } from '../features/tv/engine/dashboardDrilldown.ts';
import type { TvDashboard, TvDashNode, TvDashManager } from '../features/tv/engine/dashboard.ts';

let failures = 0;
let passed = 0;
function check(cond: boolean, label: string) {
  if (cond) { passed++; return; }
  failures++;
  console.error(`FAIL ${label}`);
}

// ── фикстура: root → branch(spb) → dept, 3 менеджера ─────────────────────────
const totalsBase = { planDay: 0, factDay: 0, salesCount: 0, bookSum: 0, bookCount: 0, activeManagers: 0, pb: 0 };

const dept: TvDashNode = {
  ...totalsBase, id: 'dept-spb', name: 'Команда Осипов', kind: 'dept',
  target: 10, managerCount: 2, children: [],
  directManagerIds: ['101', '102'], allManagerIds: ['101', '102'],
};
const branchSpb: TvDashNode = {
  ...totalsBase, id: 'branch:spb', name: 'Санкт-Петербург', kind: 'branch',
  target: 10, managerCount: 2, children: [dept],
  directManagerIds: [], allManagerIds: ['101', '102'],
};
// Узел «Москва» — по сюжету теста представляет ветку ПОЛНОСТЬЮ вне scope: у
// build() из dashboard.ts такой узел просто не попадает в children (managerCount=0
// отфильтровывается), поэтому в фикстуре его нет вовсе — то же самое дерево, что
// увидел бы РОП без доступа к Москве.
const root: TvDashNode = {
  ...totalsBase, id: 'root', name: 'Монолит', kind: 'root',
  target: 20, managerCount: 3, children: [branchSpb],
  directManagerIds: ['999'], allManagerIds: ['101', '102', '999'],
};

const managers: Record<string, TvDashManager> = {
  '101': { id: '101', name: 'Иванов', avatar: null, plan: 100, salesCount: 2, salesSum: 200000, bookCount: 1, bookSum: 50000, dealsCount: 3, active: true, pb: 3 },
  '102': { id: '102', name: 'Петров', avatar: null, plan: 100, salesCount: 0, salesSum: 0, bookCount: 0, bookSum: 0, dealsCount: 0, active: false, pb: 0 },
  '999': { id: '999', name: 'Смирнов', avatar: null, plan: 50, salesCount: 1, salesSum: 30000, bookCount: 0, bookSum: 0, dealsCount: 1, active: true, pb: 1 },
  // '201' сознательно НЕТ в managers{} — представляет менеджера вне scope /rop.
};

const dash: TvDashboard = { day: '2026-09-14', generatedAt: new Date().toISOString(), dailyTarget: 5, root, managers };

// 1. Узел на верхнем уровне.
const bySpb = resolveDrilldownSelection(dash, 'branch:spb', null);
check(bySpb !== null && bySpb.managerIds.length === 2 && bySpb.managerIds.includes('101') && bySpb.managerIds.includes('102') && bySpb.label === 'Санкт-Петербург',
  'Узел branch:spb → оба его менеджера (101, 102) и имя узла');

// 2. Узел вложенный на 2 уровня.
const byDept = resolveDrilldownSelection(dash, 'dept-spb', null);
check(byDept !== null && byDept.managerIds.sort().join(',') === '101,102' && byDept.label === 'Команда Осипов',
  'Вложенный узел dept-spb (branch → dept) находится рекурсией findNode');

// 3. Корень без явного node (клик по KPI «Итого») — nodeId=null трактуется как root.
const byRootImplicit = resolveDrilldownSelection(dash, null, null);
check(byRootImplicit !== null && byRootImplicit.managerIds.length === 3 && byRootImplicit.label === 'Монолит',
  'nodeId=null (KPI «Итого») → корень целиком, все 3 менеджера');

// 4. Менеджер по id — один id, имя из managers{}.
const byManager = resolveDrilldownSelection(dash, null, '999');
check(byManager !== null && byManager.managerIds.length === 1 && byManager.managerIds[0] === '999' && byManager.label === 'Смирнов',
  'Менеджер 999 по managerId → строго один id + имя из managers{}');

// 5. Узел вне дерева (не существует / отвалился build() как узел вне scope) → null.
const byMissingNode = resolveDrilldownSelection(dash, 'dept-moscow', null);
check(byMissingNode === null, 'Узел вне дерева (напр. Москва вне scope РОПа) → null, не пустой список наугад');

// 6. Менеджер вне managers{} (вне scope /rop) → null — прямой вызов с чужим id не
//    может получить чужие сделки.
const byMissingManager = resolveDrilldownSelection(dash, null, '201');
check(byMissingManager === null, 'Менеджер вне managers{} (вне scope /rop) → null, не подстановка чужих сделок');

// ── SQL-фрагменты: колонка даты и funnel-условие ─────────────────────────────
check(dateColumnFor('sales') === 'sold_at', "dateColumnFor('sales') === 'sold_at' — date_field primary/repeat_sales_count");
check(dateColumnFor('book') === 'reserved_at', "dateColumnFor('book') === 'reserved_at' — date_field reservations_count");
check(funnelConditionFor('sales').includes('is_repeat = false') && funnelConditionFor('sales').includes('is_repeat = true'),
  "funnelConditionFor('sales') покрывает funnel_type primary И repeat (сумма primary_sales_count+repeat_sales_count)");
check(funnelConditionFor('book') === '', "funnelConditionFor('book') === '' — у reservations_count в каталоге нет filters");

console.log(`\n${passed} passed, ${failures} failed`);
if (failures > 0) process.exit(1);
