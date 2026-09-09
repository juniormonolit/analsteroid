# Аудит доступа к данным по ролям — 09.09.2026

Требования владельца (09.09): только Администратор/супер-админ видит всё; Директор — свой филиал и ниже; РОП — себя и подконтрольные отделы с поддеревом; МОП и «Пользователь» — только себя; пикеры отделов/сотрудников тоже режутся по сессии; разделы «Ещё» и «Настройки» — только админам.

Метод: три параллельных read-only ревьюера по группам роутов `app/api/**`, каждая строка — с доказательством (файл:строка). Права ролей в БД на момент аудита: Пользователь (29 акт.) — разделов нет; РОП (13) — sales/plans/charts; Директор (4) — sales/plans/decomposition/charts/offload; Логист (3) — sales/realization/charts; Администратор (11) — всё. Страницы разделов «Ещё» (rating, product-matrix, widget-constructor, plans, decomposition, summary, metrics, offload, employees, presentation, screens, chats) серверных гейтов не имеют — держатся на скрытии пунктов меню и правах API; layout «Настроек» гейтится section.settings/action.users.manage. Статус исправлений — см. WORKLOG.


## Отчёты, графики, сводки, виджеты, ТВ

| роут | сессия | право | механизм среза | вердикт | доказательство |
|---|---|---|---|---|---|
| POST /api/reports/run | да (401) | нет | **отсутствует**: `departmentIds/managerId/accountType/grouping` из тела уходят в движки как есть; `session` после строки 56 не используется ни разу | **LEAK** | app/api/reports/run/route.ts:56 `if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });` + :123 `departmentIds,` (в `opts`) |
| GET /api/reports/deals | да (401) | нет | только `teamId='my'` резолвится по сессии; `managerId`, `managerIds`, `all=1`, `departmentIds`, `contactId`, `companyId` — доверяются клиенту | **LEAK** | app/api/reports/deals/route.ts:134 `const all = sp.get('all') === '1';     // drilldown строки «Итого» — весь срез`; :308 `if (managerId) { params.push(managerId);` |
| GET /api/reports/client-deals | да (401) | нет | `departmentIds` из query, срез по сессии не применяется | **LEAK** | app/api/reports/client-deals/route.ts:59 `departmentIds: (sp.get('departmentIds') ?? '').split(',').filter(Boolean),` |
| POST /api/reports/by-periods | да (401) | нет | `dimension='managers'`+`departmentIds` из тела, без фильтра по сессии | **LEAK** | app/api/reports/by-periods/route.ts:80 `if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });` (session дальше не используется) |
| POST /api/reports/metric-series | да (401) | нет | `managerIds`/`departmentIds` берутся из тела, только формат-валидация | **LEAK** | app/api/reports/metric-series/route.ts:31 `const managerIds = Array.isArray(body.managerIds)` |
| POST /api/reports/product-matrix | да (401) | нет | срез компанейский, параметров скоупа нет вовсе | **LEAK** (данные всей компании любому) | app/api/reports/product-matrix/route.ts:20 `if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });` |
| GET /api/reports/repeat | да | `superadminError` | доступ только супер-админу | **ADMIN-ONLY** | app/api/reports/repeat/route.ts:15 `const err = superadminError(session);` |
| GET /api/reports/deal | да (401) | нет | по `?id` отдаётся любая сделка (сумма, менеджер, клиент) без сверки владельца | **LEAK** (IDOR) | app/api/reports/deal/route.ts:35 `WHERE d.deal_id = $1` |
| GET /api/reports/deal/calls | да (401) | нет | звонки любой сделки по числовому `id` | **LEAK** (IDOR) | app/api/reports/deal/calls/route.ts:39 `WHERE deal_id = $1` |
| GET /api/reports/deal-filter-options | да (401) | нет (осознанно) | справочники воронок/стадий/групп, без данных о деньгах | **OK** (не данные) | app/api/reports/deal-filter-options/route.ts:15 `if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });` |
| GET/POST/PUT/DELETE /api/saved-reports, /[id], /[id]/move, /restore, /permanent, /trash | да (401) | `isReportAdmin`/`action.shared_reports.manage` для витрин | владение по `user_login`, витринные — админ; хранит только КОНФИГ отчёта, не данные | **OK** | app/api/saved-reports/route.ts:59 `WHERE (user_login = $1 OR is_shared = true) AND deleted_at IS NULL`; app/api/saved-reports/[id]/route.ts:33 `if (row.user_login !== session.login && !(row.is_shared && isAdmin))` |
| POST /api/charts/{called-to-sale-cohort, stage-survival, work-days-cohort, work-excl-reserved-cohort} | да | `section.charts` | **нет среза**: `departmentIds` из тела; при пустом — вся компания. Право есть у МОП (миграция 106 дала `section.charts` всем с `section.sales`) | **LEAK** | app/api/charts/called-to-sale-cohort/route.ts:43 `const departmentIds = Array.isArray(body.departmentIds)`; migrations/106_charts_section_perm.sql:10 `SET permissions = array_append(permissions, 'section.charts')` |
| POST /api/charts/*/deals (все 4) | да | `section.charts` | то же — список сделок по когорте по любому `departmentIds` | **LEAK** | app/api/charts/stage-survival/deals/route.ts:54 `const departmentIds = Array.isArray(body.departmentIds)` |
| GET/POST/DELETE /api/charts/saved | да (401) | нет | строго свои записи по `session.login` | **OK** | app/api/charts/saved/route.ts:47 `SELECT id, name, config FROM saved_charts WHERE user_login = $1 ORDER BY name` |
| GET /api/summary/daily-sales | да (401) | нет (`section.summary` только на странице) | `resolveSummaryScope` → `managerIds` из `user_departments`+поддерево; нет назначений и не элевейтед → `hasAccess:false` | **OK** | app/api/summary/daily-sales/route.ts:37 `const days = aggregateDailySales(rows, scope.managerIds, fromDayStr, toDayStr);` |
| GET /api/summary/funnel | да (401) | нет | тот же `resolveSummaryScope`, фильтр после кэша | **OK** | app/api/summary/funnel/route.ts:76 `if (!scope.managerIds.has(managerId)) continue;` |
| GET /api/summary/today | да (401) | нет | тот же скоуп, и по сделкам, и по звонкам | **OK** | app/api/summary/today/route.ts:54 `if (!scope.managerIds.has(row.dimensionId)) continue;` |
| GET /api/summary/top-managers | да (401) | нет | фильтр по `scope.managerIds` | **OK** | app/api/summary/top-managers/route.ts:45 `.filter(r => scope.managerIds.has(r.dimensionId))` |
| GET /api/summary/plan | да (401) | нет | **никакого**: один глобальный кэш «план/факт по всем филиалам и отделам» отдаётся любой сессии | **LEAK** | app/api/summary/plan/route.ts:9 `const summary = await getCachedPlanSummary();` (см. lib/summary/scope.ts:13-19 — исключение задокументировано) |
| GET /api/widget-metrics/plan | нет сессии | общий env-токен `WIDGET_API_TOKEN` | один секрет на всех, отдаёт тот же компанейский план | **LEAK** (общий секрет = данные компании) | app/api/widget-metrics/plan/route.ts:6 `const expected = process.env.WIDGET_API_TOKEN;` |
| GET /api/widget-metrics/custom | нет cookie; персональный bearer в query | нет | токен → user_id → его конфиг; но конфиг может указывать ЛЮБОЙ филиал/отдел из блоба | **LEAK** (срез не проверяется против прав владельца токена) | app/api/widget-metrics/custom/route.ts:27 `const slice = sliceForConfig(blob, config);` |
| GET /api/widget-constructor/catalog | да (401) | нет | отдаёт список ВСЕХ филиалов и отделов как доступные разрезы | **LEAK** (перечисление скоупов) | app/api/widget-constructor/catalog/route.ts:15 `const catalog = buildCatalog(blob);` |
| GET/PUT /api/widget-constructor/config | да (401) | нет | конфиг привязан к `session.id`, но `scope_id` не валидируется против прав | **PARTIAL** | app/api/widget-constructor/config/route.ts:23 `await saveWidgetConfig(session.id, result.config);` |
| POST /api/widget-constructor/preview | да (401) | нет | любая сессия получает метрики любого филиала/отдела из блоба | **LEAK** | app/api/widget-constructor/preview/route.ts:20 `const slice = sliceForConfig(blob, result.config);` |
| GET/POST/DELETE /api/widget-constructor/tokens | да (401) | нет | токены только свои (`session.id`) | **OK** | app/api/widget-constructor/tokens/route.ts:25 `const ok = await revokeWidgetToken(session.id, token);` |
| POST /api/widget-constructor/send-script | да (401) | нет | шлёт скрипт себе в Битрикс по `session.bitrixUserId` | **OK** | app/api/widget-constructor/send-script/route.ts:30 `await sendBitrixBotMessage(session.bitrixUserId, message, undefined, 'widget_script');` |
| GET /api/year-weekly | да | `section.year_weekly` | среза нет — данные всей компании, но раздел по умолчанию только у супер-админа | **ADMIN-ONLY** (по факту выдачи права) | app/api/year-weekly/route.ts:10 `const err = permError(session, 'section.year_weekly');` |
| PATCH /api/year-weekly/weather | да | `superadminError` | — | **ADMIN-ONLY** | app/api/year-weekly/weather/route.ts:11 `const err = superadminError(session);` |
| GET /api/tv/dashboard | да | `section.tv` | `tvScope` + `prune` до разрешённых узлов; полный доступ — через `hasFullManagerAccess` (Директор — всё) | **OK** (Директор — через hasFullManagerAccess) | app/api/tv/dashboard/route.ts:22 `const roots = prune(dash.root, scope.allowedDeptIds ?? new Set());`; features/tv/engine/access.ts:28 `if (hasFullManagerAccess(session)) return { allowedDeptIds: null, full: true };` |
| GET /api/tv/tree | да | `section.tv` | **не режется** `tvScope` — отдаётся всё дерево оргструктуры (филиалы/отделы/команды) | **PARTIAL** (оргструктура без денег) | app/api/tv/tree/route.ts:11 `const tree = await buildTvTree();` |
| GET/POST /api/tv/screens, GET/PATCH/DELETE /api/tv/screens/[id], /pair, /ticker, /token | да | `section.tv` | `tvScope`+`screenInScope`/`filterScreens` на каждом входе и на записи | **OK** (Директор — через hasFullManagerAccess) | app/api/tv/screens/route.ts:25 `if (!screenInScope(scope, input.departmentIds))`; app/api/tv/screens/[id]/route.ts:18 `if (!screenInScope(scope, screen.departmentIds))` |
| GET/POST /api/tv/messages, DELETE /api/tv/messages/[id] | да | `section.tv` | «на все экраны» — только `scope.full`; адресные — только видимые экраны | **OK** | app/api/tv/messages/route.ts:31 `if (!scope.full) return NextResponse.json({ error: 'Рассылка на все экраны доступна только руководству' }, { status: 403 });` |
| GET/PATCH/DELETE /api/tv/devices/[id], /api/tv/media (POST) | да | `section.tv` | `guard()` через экран устройства + `screenInScope` | **OK** | app/api/tv/devices/[id]/route.ts:18 `if (!screen || !screenInScope(scope, screen.departmentIds))` |
| GET /api/tv/feed | **нет** (публично) | нет | токен устройства (32 hex) / публичный токен экрана (16 байт), `nodeWithin` ограничивает под-узлы экрана | **OK-by-design** (данные отдела в токене) | app/api/tv/feed/route.ts:45 `if (!nodeWithin(tree, deptIds, nodeParam)) return json({ state: 'error', v, now, message: 'Узел вне экрана' }, 403);` |
| GET /api/tv/stream | **нет** (публично) | нет | в потоке только сигнал «что-то изменилось», данных нет; rate-limit по IP | **OK-by-design** | app/api/tv/stream/route.ts:25 `if (rateLimited(\`tv:stream:${ip ?? 'na'}\`, 10, 60)) return tooMany();` |
| POST /api/tv/device, GET /api/tv/media/[id] | **нет** (публично) | нет | регистрация по IP-лимиту; медиа по uuid | **OK-by-design** | app/api/tv/device/route.ts:11 `if (rateLimited(\`tv:dev:${ip ?? 'na'}\`, 5, 600)) return tooMany();` |
| proxy.ts (глобальный гейт) | только для страниц | — | `/api/*` полностью пропускается мимо гейта («API handles auth itself»); PUBLIC-сегмент `/tv` | **PARTIAL** (второго рубежа для API нет) | proxy.ts:37 `if (pathname.startsWith('/api/')) return NextResponse.next(); // API handles auth itself` |

Главные дыры

1. `/api/reports/run` — единственная проверка «есть сессия»; ни `section.sales`, ни фильтра по менеджерам. Любой залогиненный (МОП, «Пользователь» с пустыми правами, автосозданный из Битрикса) POST-ом получает отчёт по ВСЕМ менеджерам компании со строкой «Итого» — суммы продаж/отгрузок, звонки, планы, рейтинги (app/api/reports/run/route.ts:56).
2. `/api/reports/deals` — `all=1` и произвольный `managerId`/`managerIds`/`departmentIds` не сверяются с сессией: выгрузка списка сделок всей компании или конкретного чужого менеджера (app/api/reports/deals/route.ts:134, :308).
3. `/api/reports/deal` и `/api/reports/deal/calls` — чистый IDOR по числовому `deal_id`: карточка любой сделки (сумма, клиент, менеджер, товары) и вся история звонков по ней (app/api/reports/deal/route.ts:35; app/api/reports/deal/calls/route.ts:39).
4. Раздел «Графики» — все 8 роутов гейтятся `section.charts`, которое миграция 106 автоматически раздала всем ролям с `section.sales` (включая МОП), а среза по сессии нет: когорты и списки сделок по любому `departmentIds` или по всей компании (app/api/charts/*/route.ts:43-54, migrations/106_charts_section_perm.sql:10).
5. `/api/summary/plan` + `/api/widget-metrics/plan` — глобальный кэш «план/факт по филиалам и отделам» отдаётся любой сессии без права `section.summary` и, во втором случае, по одному общему env-токену без привязки к пользователю (app/api/summary/plan/route.ts:9; app/api/widget-metrics/plan/route.ts:6).
6. `/api/widget-constructor/preview` и `/catalog` (+ `/api/widget-metrics/custom` по персональному токену) — `scope_id` конфига не проверяется против прав: любая сессия перечисляет все филиалы/отделы и вытягивает их метрики (app/api/widget-constructor/preview/route.ts:20, /catalog/route.ts:15).
7. `/api/reports/by-periods`, `/api/reports/metric-series`, `/api/reports/client-deals`, `/api/reports/product-matrix` — тот же класс: сессия проверена, `managerIds`/`departmentIds` приняты на веру (или скоупа нет вовсе), то есть весь «Монолитик» доступен любому аккаунту в обход UI. Дополнительно `proxy.ts:37` явно снимает гейт со всех `/api/*`, поэтому второго рубежа под этими роутами нет.


## Клиенты, карточки, планы, пикеры, профили

| роут | сессия | право | механизм среза | вердикт | доказательство |
|---|---|---|---|---|---|
| `customers` | 401 есть | нет perm-ключа, только `canViewManager` | `bitrixId` из query, но сверяется | OK | `app/api/customers/route.ts:143` `if (bitrixId !== session.bitrixUserId && !(await canViewManager(session, bitrixId)))` |
| `customers/card` | 401 есть | `canViewManager` | двойной рубеж: менеджер + принадлежность clientKey его списку | OK | `app/api/customers/card/route.ts:26` `if (!rows.some(r => r.clientKey === clientKey))` |
| `customers/journey` | 401 есть | НЕТ | доверяет `contactId`/`companyId` без сверки владельца; сессия нигде не используется после 401 | LEAK | `app/api/customers/journey/route.ts:25` `const where = companyId ? 'd.company_id = $1' : 'd.contact_id = $1';` — МОП перебором id читает всю историю отгрузок (суммы, товарные группы) любого клиента компании |
| `customers/mark` | 401 есть | `canViewManager` | + клиент обязан быть в списке менеджера | OK | `app/api/customers/mark/route.ts:38` `const rows = await fetchManagerCustomers(Number(managerId));` |
| `customers/resolve` | 401 есть | НЕТ | `contactId`/`companyId` доверенные | LEAK | `app/api/customers/resolve/route.ts:50-57` возвращает `{ clientKey, managerId }` по любому id — раскрывает, чей клиент, и даёт ключ для дальнейших запросов |
| `customers/team` | 401 есть | нет ключа; охват от сессии | `getCallControlManagedDepts(session.bitrixUserId)`, параметров нет | OK | `app/api/customers/team/route.ts:18` `const managed = await getCallControlManagedDepts(session.bitrixUserId);` |
| `manager-card` | 401 есть | `managerAccessError` | `managerId` из тела, сверяется | OK (Директор — всё через `hasFullManagerAccess`) | `app/api/manager-card/route.ts:39` `const accessErr = await managerAccessError(session, managerId);` |
| `manager-card/activity` | 401 есть | `managerAccessError` | сверка `managerId` | OK | `app/api/manager-card/activity/route.ts:22` |
| `manager-card/daily-sales` | 401 есть | `managerAccessError` + сверка uuid отдела | обе ветки режут | OK | `app/api/manager-card/daily-sales/route.ts:43` и `:27-30` `if (!allowed.includes(departmentId)) … 403` |
| `manager-card/department-card` | 401 есть | `canViewDepartmentData` + `optionIds` | отдел только из `getUserDepartmentOptions(session.id)`; для «elevated» — фолбэк на корни | OK / ADMIN-ONLY | `app/api/manager-card/department-card/route.ts:167` `if (!optionIds.has(departmentId)) … 403`; `:50` `const isElevated = session.isSuperadmin \|\| session.roleName === 'Директор' …` |
| `manager-card/leader-skills` | 401 есть | НЕТ гейта на `?bitrixId=` | целевой id доверенный: считает скиллы отделов ЧУЖОГО руководителя | LEAK | `app/api/manager-card/leader-skills/route.ts:22` `const managed = await getCallControlManagedDepts(target);` (где `target` = `searchParams.get('bitrixId')`, `:19`) |
| `manager-card/plan-fact` | 401 есть | ветка `department` — да; ветка `manager` — гейт снят | `managerId` берётся как есть | LEAK (по решению 05.08, но противоречит модели владельца) | `app/api/manager-card/plan-fact/route.ts:30` `managerIds = [managerId];` (коммент `:24` «Гейт managerAccessError снят СОЗНАТЕЛЬНО») — любой МОП видит план/факт (сумму месяца) любого менеджера |
| `manager-card/team` | 401 есть | `canViewDepartmentData` + `optionIds` | режет по `getUserDepartmentOptions(session.id)` | OK | `app/api/manager-card/team/route.ts:57` `if (!optionIds.has(departmentId)) … 403` |
| `team/roster` | 401 есть | нет ключа; охват от сессии | id из запроса не принимаются вовсе | OK | `app/api/team/roster/route.ts:31` `buildPeerRoster({ bitrixUserId: session.bitrixUserId, period })` |
| `employees` | 401 через `permError` | `section.employees` (по умолчанию только суперадмин) | среза по сессии НЕТ — весь реестр компании любому носителю права | PARTIAL (реестр-пикер не режется) | `app/api/employees/route.ts:29` `const rows = await getEmployeesList();` |
| `employees/registry` | 401 через `permError` | `section.employees` | `bitrixId` из тела доверенный — правка стажа/заметок ЛЮБОГО сотрудника | PARTIAL | `app/api/employees/registry/route.ts:46` `await upsertRegistry(bitrixId, patch, session!.login);` |
| `me/departments` | 401 есть | нет | всё по `session.id`; сохраняемые id — лишь UI-фильтр, доступ не расширяют | OK | `app/api/me/departments/route.ts:35` `[session.id, ids]` |
| `me/dept-summary` | 401 есть | нет | по `session.id` | OK | `app/api/me/dept-summary/route.ts:11` `computeUserDeptSummary(session.id)` |
| `me/direct-access` | 401 есть | нет | токен привязан к `session.id`, чужой id не принимается | OK | `app/api/me/direct-access/route.ts:34` `[session.id, token, expiresAt]` |
| `catalog/org-structure` | 401 есть | НЕТ | отдаёт ВСЁ поддерево «Отдел продаж» любой сессии | LEAK (пикер) | `app/api/catalog/org-structure/route.ts:22` `FROM sa.departments WHERE is_active = true` → `:46` `return NextResponse.json({ tree: salesTree })` |
| `catalog/marketing-sources` | 401 есть | НЕТ | справочник + карта «менеджер→филиал» по ВСЕМ менеджерам | PARTIAL | `app/api/catalog/marketing-sources/route.ts:11` `loadManagerBranchMap()` |
| `catalog/product-groups` | 401 есть | НЕТ | справочник товаров, персональных данных нет | OK | `app/api/catalog/product-groups/route.ts:29` |
| `my-report` | 401 есть | через `resolveEntities` (403 `EntityAccessError`) | сущности сверяются с `managedDepartmentIds` | OK | `lib/reports-builder/entities.ts:116` `if (allowedDepts && !allowedDepts.has(e.id)) throw new EntityAccessError(...)` |
| `my-report/entities` | 401 есть | `availableEntities(session)` | пикер режется: не-full получает пересечение продаж и `managedDepartmentIds`, филиалы — пустые | OK | `lib/reports-builder/entities.ts:71-77` `full ? getSalesDepartmentOptions() : managedDepartmentIds(session).then(...) filter(d => allowed.has(d.id))` |
| `my-report/templates` | 401 есть | пресеты через `availableEntities`, личные — по `session.login` | чужой шаблон не читается/не удаляется | OK | `app/api/my-report/templates/route.ts:122` (presets.ts:122 `availableEntities(session)`), `:42` `WHERE id = $1::uuid AND user_login = $2` |
| `plans` | 401 есть | НЕТ права и НЕТ среза | отдаёт планы ВСЕХ менеджеров всех месяцев любому залогиненному | LEAK | `app/api/plans/route.ts:15` `'SELECT manager_login, … FROM manager_plans ORDER BY month, manager_login'` |
| `plans/[login]/[month]` | 401 через `permError` | `action.plans.edit` | `login` из URL не сверяется с поддеревом сессии | PARTIAL | `app/api/plans/[login]/[month]/route.ts:26` `[login, monthDate, body.plan_shipments, body.plan_n]` |
| `plans/employees` | 401 есть | НЕТ | полный ростер компании (логин, ФИО, отдел) любой сессии | LEAK (пикер/реестр) | `app/api/plans/employees/route.ts:26` `WHERE orh.is_active = true` |
| `plans/export` | 401 есть | НЕТ | `deptIds` из query доверенные; без них — выгрузка всех сотрудников в xlsx | LEAK | `app/api/plans/export/route.ts:30` `SELECT short_login, manager_name FROM sa.org_resolved_hierarchy WHERE is_active = true` |
| `plans/import` | 401 через `permError` | `action.plans.edit` | логины из файла не сверяются с областью сессии | PARTIAL | `app/api/plans/import/route.ts:42` `WHERE month = $1 AND manager_login = ANY($2)` |
| `plans/import/confirm` | 401 через `permError` | `action.plans.edit` | `items[].login` доверенные — запись плана любому логину | PARTIAL | `app/api/plans/import/confirm/route.ts:33` `[item.login, monthDate, item.amount, plan_n]` |
| `plans/settings` | GET — 401; PUT — `permError` | `action.plans.edit` на запись | глобальная настройка, срез не нужен | OK | `app/api/plans/settings/route.ts:18` |
| `planyorka` | 401 есть | `canViewManager` | `bitrixId` сверяется | OK | `app/api/planyorka/route.ts:28` |
| `planyorka/team` | 401 есть | охват от сессии | параметров id нет | OK | `app/api/planyorka/team/route.ts:22` `getCallControlManagedDepts(session.bitrixUserId)` |
| `rating` | 401 есть | `hasFullManagerAccess` / `managedDepartmentIds` | ранги считаются по всем, но строки фильтруются | OK (утекает лишь `total`/`poolSize`) | `app/api/rating/route.ts:50-55` `visible = new Set(roster.map(m => m.managerId)); … .filter(r => visible === null \|\| visible.has(r.managerId))` |
| `offload/tree` | `permError` | `section.offload` (дефолт — суперадмин) | `departmentIds` из тела доверенные, среза по сессии нет | ADMIN-ONLY / PARTIAL при выдаче права | `app/api/offload/tree/route.ts:25` `const departmentIds = Array.isArray(body.departmentIds) …` |
| `offload/deals` | `permError` | `section.offload` | `managerId` и `departmentIds` доверенные | ADMIN-ONLY / PARTIAL | `app/api/offload/deals/route.ts:23` `const managerId = String(body.managerId ?? '');` (без `canViewManager`) |
| `offload/close` | `permError` | `section.offload` | `dealIds` доверенные (закрытие чужих сделок в Битриксе) | ADMIN-ONLY / PARTIAL | `app/api/offload/close/route.ts:39` `await closeDeals(session!, dealIds, {...})` |
| `offload/log` | `permError` | `section.offload` | весь лог, 300 записей | ADMIN-ONLY | `app/api/offload/log/route.ts:13` `FROM offload_close_log ORDER BY closed_at DESC` |
| `deal-chats` | `permError` | `action.deal_chats` | GET режется по `session.id`; POST принимает ЛЮБОЙ `dealId` и пишет менеджеру сделки | PARTIAL | `app/api/deal-chats/route.ts:19` `getDealChatStatuses(session!.id, dealIds)` (OK) vs `:40` `sendDealChatMessage({ dealId, authorUserId: session!.id … })` (без проверки сделки) |
| `deal-chats/thread` | `permError` | `action.deal_chats` | тред только свой | OK | `lib/deal-chats/service.ts:126` `WHERE id = $1 AND created_by_user_id = $2` |
| `profile/cosmetics` | 401 есть | нет | только `session.bitrixUserId` | OK | `app/api/profile/cosmetics/route.ts:77` `const bitrixId = Number(session.bitrixUserId);` |
| `profile/cover` | 401 есть | нет | только своя обложка | OK | `app/api/profile/cover/route.ts:51` `const idNum = Number(session.bitrixUserId);` |
| `profile/feed` | 401 есть | НЕТ | `bitrixId` доверенный — лента чужого профиля с ИМЕНАМИ СДЕЛОК и СУММАМИ | LEAK | `app/api/profile/feed/route.ts:117` `WHERE current_manager_id = $1 AND sold_at IS NOT NULL AND amount >= $2` |
| `profile/people` | 401 есть | НЕТ | весь справочник активных менеджеров любой сессии | LEAK (пикер, по решению 05.08) | `app/api/profile/people/route.ts:29` `WHERE h.is_active = true AND h.manager_bitrix_user_id IS NOT NULL` |
| `profile/public` | 401 есть | НЕТ | личность по любому `bitrixId` (имя/отдел/филиал/аватар) | PARTIAL (по решению владельца) | `app/api/profile/public/route.ts:32` `WHERE h.manager_bitrix_user_id::text = $1` |
| `profile/pulse` | 401 есть | НЕТ | `scope=dept` — только выбор клиента; дефолт `company` отдаёт продажи всей компании с суммами | LEAK | `app/api/profile/pulse/route.ts:58-60` `const deptIds = scope === 'dept' && viewerDeptId ? … : null; // null = вся компания` |
| `profile/randomizer` | 401 есть | нет | только себя | OK | `app/api/profile/randomizer/route.ts:16-17` `if (!session?.bitrixUserId) return null; const n = Number(session.bitrixUserId);` |
| `presentation` | 401 + `permError` | `section.presentation` (дефолт — суперадмин) | `departmentIds` из тела не сверяются | ADMIN-ONLY / PARTIAL при выдаче права | `app/api/presentation/route.ts:35` `buildPresentation({ departmentIds, … })` |
| `lib/reports-builder/entities.ts` | n/a | `hasFullManagerAccess` / `managedDepartmentIds` | и пикер (`availableEntities`), и резолв (`resolveEntities`) режут | OK | `lib/reports-builder/entities.ts:96` `const allowedDepts = full ? null : new Set(await managedDepartmentIds(session));` |
| `lib/org/teamRoster.ts::getSalesDepartmentOptions` | n/a | НЕТ параметра сессии | отдаёт ВСЁ поддерево «Отдел продаж» — режет только вызывающий | LEAK-источник (безопасен лишь в `entities.ts`) | `lib/org/teamRoster.ts:156` `export async function getSalesDepartmentOptions(): Promise<DeptOption[]>` — без аргумента сессии |

**Главные дыры**

1. `plans` + `plans/employees` + `plans/export` — три роута без единого гейта: любой залогиненный (МОП, автосозданный) читает планы ВСЕХ менеджеров (`app/api/plans/route.ts:15`), полный ростер компании (`app/api/plans/employees/route.ts:26`) и скачивает его xlsx (`app/api/plans/export/route.ts:30`).
2. `customers/journey` и `customers/resolve` — единственные роуты `customers/*` без проверки владельца: `contactId`/`companyId` доверенные, перебор id даёт историю отгрузок с суммами и имя менеджера-владельца любого клиента (`app/api/customers/journey/route.ts:25`, `app/api/customers/resolve/route.ts:50`).
3. `manager-card/plan-fact` (ветка `manager`) — гейт `managerAccessError` снят, `managerIds = [managerId]` (`:30`): месячный план/факт любого менеджера доступен любому. `manager-card/leader-skills` — та же схема через `?bitrixId=` (`:22`): агрегаты чужого отдела.
4. Пикеры не режутся по сессии: `catalog/org-structure` отдаёт всё поддерево продаж любой сессии (`:22`), `plans/employees` — всех людей, `employees` — весь реестр носителю `section.employees`. Корень — `getSalesDepartmentOptions()` без параметра сессии (`lib/org/teamRoster.ts:156`); правильный образец среза есть рядом — `lib/reports-builder/entities.ts:71-77`.
5. `profile/pulse` (дефолт `scope=company`, `:58-60`) и `profile/feed` (`:117`) публикуют имена сделок и суммы по всей компании/любому менеджеру — денежные данные вне гейта `canViewManager`, хотя `manager-card` те же цифры закрывает.
6. Записывающие роуты доверяют идентификатору цели без сверки поддерева: `plans/[login]/[month]:26`, `plans/import/confirm:33`, `employees/registry:46`, `deal-chats` POST `:40`. Носитель `action.plans.edit`/`action.deal_chats` действует на любого сотрудника компании.
7. `offload/*` и `presentation` держатся только на том, что `section.offload`/`section.presentation` по умолчанию у суперадмина: `managerId`/`departmentIds`/`dealIds` внутри не сверяются ни с чем (`offload/deals:23`, `offload/tree:25`, `offload/close:39`, `presentation:35`) — выдача права роли «РОП» сразу открывает всю компанию.


## Геймификация, настройки, админ, служебные

| роут | сессия | право | механизм среза | вердикт | доказательство |
|---|---|---|---|---|---|
| POST /api/badges/batch | да, 401 | нет | нет — принимает произвольный массив до 500 чужих bitrixId | **LEAK** | `app/api/badges/batch/route.ts:21` `const ids = [...new Set(raw.map(Number)...)]` → `getBalances(db, ids)` (:35); комментарий :10 «Доступ: любой залогиненный» |
| GET /api/badges/collection | да, 401 | нет | нет — `?bitrixId=` любой | **LEAK** | `app/api/badges/collection/route.ts:55` `const bitrixId = requested && /^\d+$/.test(requested) ? requested : session.bitrixUserId;` |
| GET /api/badges/profile | да, 401 | нет | нет — `?bitrixId=` любой; отдаёт весь леджер (штрафы, комментарии, actor_login, стаж) | **LEAK** | `app/api/badges/profile/route.ts:21` тот же паттерн; :12-14 «Раньше стоял canViewManager — снят СОЗНАТЕЛЬНО» |
| POST /api/badges/convert | да, 401 | нет | только себя | OK | `badges/convert/route.ts:38` `const id = Number(session.bitrixUserId);` |
| GET /api/badges/me | да, 401 | нет | только себя | OK | `badges/me/route.ts:16` |
| GET /api/badges/manual | да, 401 | `canManualFor` | hasFullManagerAccess ∪ managedDepartmentIds+roster; иначе `{canManual:false}` | OK (через hasFullManagerAccess) | `badges/manual/route.ts:16-21`, :74 |
| POST /api/badges/manual | да, 401 | `canManualFor` | тот же расчёт, 403 | OK | `badges/manual/route.ts:109-111` |
| POST /api/badges/manual/reverse | да, 401 | superadminError | — | ADMIN-ONLY | `badges/manual/reverse/route.ts:13` |
| GET /api/badges/payout | да, 401 | `manageScope` при `?scope=manage` | 'all' для full-access, иначе Set(roster managed-депт); без scope — только свои | OK | `badges/payout/route.ts:16-23`, :34 `WHERE p.bitrix_id = ANY($1::int[])` |
| PATCH /api/badges/payout | да, 401 | `manageScope` | 403 «Заявки этого сотрудника вам недоступны» | OK | `badges/payout/route.ts:165` |
| GET /api/badges/penalty-types | да, 401 | нет | справочник, не персданные | OK | `badges/penalty-types/route.ts:5-6` комментарий «Публичный справочник» |
| POST /api/badges/recompute | да, 401 | superadminError | — | ADMIN-ONLY | `badges/recompute/route.ts:14` |
| GET /api/badges/team | да, 401 | нет явного | `getCallControlManagedDepts(session.bitrixUserId)` → пусто = пустая выдача | OK (строже модели: админ без КЗ-депт видит пусто) | `badges/team/route.ts:22-24` |
| GET /api/quests | да, 401 | canViewManager | `?bitrixId` проверяется, иначе 403 | OK | `quests/route.ts:17-18` |
| POST /api/quests/contracts | да, 401 | нет | только себя | OK | `quests/contracts/route.ts:16` |
| POST /api/quests/reroll | да, 401 | нет | только себя | OK | `quests/reroll/route.ts:21` |
| GET /api/quests/team | да, 401 | нет явного | managed КЗ-депты сессии | OK | `quests/team/route.ts:16-17` |
| GET /api/shop | да, 401 | canViewManager | `?bitrixId` проверяется | OK | `shop/route.ts:63-64` |
| POST /api/shop | да, 401 | нет | покупка только себе | OK | `shop/route.ts:184` |
| GET /api/shop/activate?scope=manage | да, 401 | `manageScope` | 'all' / Set(roster), иначе `canManage:false` | OK | `shop/activate/route.ts:17-23`, :37 |
| POST/PATCH /api/shop/activate | да, 401 | `manageScope` | 403 | OK | `shop/activate/route.ts:170` |
| GET/POST /api/shop/gacha, /transfer, POST /shop/gift | да, 401 | нет | источник всегда `session.bitrixUserId` | OK | `shop/gift/route.ts:24`, `shop/transfer/route.ts:65` |
| GET /api/shop/team-budget | да, 401 (`session?.bitrixUserId`) | нет | `fetchTeamScope` → только КЗ-депты сессии; не руководитель → пустой ответ | OK | `shop/team-budget/route.ts:18`; `features/shop/engine/teamScope.ts:27-28` |
| GET/POST /api/boosts | да, 401 | нет | только свой bitrixId | OK | `boosts/route.ts:12-13`, :34 |
| GET /api/skills | да, 401 | нет | нет — `?bitrixId=` любой, отдаёт дерево + `balance` коллеги | **LEAK** | `skills/route.ts:20-22` `const mgr = Number.isFinite(asked) && asked > 0 ? asked : self;` |
| POST /api/skills | да, 401 | нет | покупка только себе (чужой id в теле игнорируется) | OK | `skills/route.ts:46-48` |
| GET/POST/PATCH/DELETE /api/report-groups | да, 401 | нет | всё по `session.login` в WHERE | OK | `report-groups/route.ts:28` `WHERE user_login = $1 AND dimension_key = $2` |
| GET /api/user-highlights, GET/PUT /api/user-highlights/[metricId] | да, 401 | нет | по `session.login` | OK | `user-highlights/route.ts:12`; `[metricId]/route.ts:17`, :41 |
| GET/POST /api/ideas | да, 401 | нет | общая лента (по замыслу) | OK | `ideas/route.ts:70-71` |
| PATCH /api/ideas/[id] | да, 401 | permError `action.shared_reports.manage` | — | OK | `ideas/[id]/route.ts:16` |
| GET/POST /api/ideas/[id]/attachments | да, 401 | нет | общая лента | OK | `ideas/[id]/attachments/route.ts:33-34` |
| GET /api/ideas/[id]/attachments/[attId] | да, 401 | нет | байты вложения любому | OK (внутренний инструмент) | `.../[attId]/route.ts:11-12` |
| DELETE /api/ideas/[id]/attachments/[attId] | да, 401 | автор ∪ `action.shared_reports.manage` | 403 | OK | `.../[attId]/route.ts:51-53` |
| GET/PATCH /api/notifications | да, 401 | нет | только свой bitrixId | OK | `notifications/route.ts:12`, :32 |
| GET /api/changelog, POST /api/changelog/seen | да, 401 | нет | общая лента, read-state по `session.id` | OK | `changelog/route.ts:26` |
| GET /api/features | да, 401 | нет | флаги фич, не данные | OK | `features/route.ts:9-10` |
| GET /api/catalog/metrics | да, 401 | нет | каталог метрик (метаданные) | OK | `catalog/metrics/route.ts:6-7` |
| POST /api/catalog/metrics/[id]/verify | да, 401 | superadminError | — | ADMIN-ONLY | `catalog/metrics/[id]/verify/route.ts:16` |
| POST /api/telephony/webhook | нет (публичный) | секрет в query | `?token` === `TELEPHONY_WEBHOOK_SECRET`, пустой env → 403 | OK (PARTIAL: токен в URL, сравнение не constant-time) | `telephony/webhook/route.ts:41-43` `if (!secret \|\| req.nextUrl.searchParams.get('token') !== secret)` |
| POST /api/bitrix/events | **нет** | **нет** | никакой — ни токена, ни `application_token` | **LEAK (открытый write-эндпоинт)** | `bitrix/events/route.ts:33` `export async function POST(req: NextRequest) {` — во всём файле (123 стр.) нет ни `token`, ни `secret`, ни `auth` |
| POST /api/bitrix/app | нет (вход) | AUTH_ID валидируется у портала | `identifyByAuthId` → 403 | OK | `bitrix/app/route.ts:61-64` |
| POST /api/auth/login | нет | bcrypt | — | OK (нет rate-limit) | `auth/login/route.ts:24-27` |
| GET /api/auth/session | да, 401 | нет | отдаёт свою сессию целиком (`permissions`, `isSuperadmin`) | OK | `auth/session/route.ts:6-7` |
| POST /api/auth/logout | нет | cookie | — | OK | `auth/logout/route.ts:7-8` |
| GET /api/invite/[token] | нет | знание токена | отдаёт `display_name` по токену | OK (PARTIAL: перебор токенов не ограничен) | `invite/[token]/route.ts:16-22` |
| POST /api/invite/[token]/accept | нет | знание токена | ставит пароль + активирует юзера + выдаёт сессию | OK (PARTIAL: нет rate-limit/лока) | `invite/[token]/accept/route.ts:28-33` |
| settings/badges/** (route, [key], budget, currency, dashboard, gacha, grant, groups, penalties, penalties/[id], quest-templates, quest-templates/preview, quests, rate, release, shop, shop/fetch-image-url, transfer, ttl, xp) | да | superadminError на КАЖДОМ методе | — | ADMIN-ONLY | напр. `settings/badges/route.ts:13`, `settings/badges/shop/route.ts:28/240/269` |
| settings/bots/call-control/** (route, deliveries, departments, employees, report, rules, rules/[id], templates, templates/[id]) | да | permError `section.settings` | — | ADMIN-ONLY (право выдаётся ролью) | `settings/bots/call-control/route.ts:12`, `.../rules/[id]/route.ts:11/56` |
| settings/bots/{channels, inbound, master, report-schedules*, scenarios*} | да | superadminError | — | ADMIN-ONLY | `settings/bots/scenarios/route.ts:90/99/119/152` |
| GET/PUT /api/settings/card-templates | да | permError `section.settings` | — | ADMIN-ONLY | `settings/card-templates/route.ts:34`, :95 |
| GET/PUT /api/settings/customer-categories | да | superadminError | — | ADMIN-ONLY | `settings/customer-categories/route.ts:13`, :30 |
| GET/PUT /api/settings/daily-plan-mode | да | superadminError | — | ADMIN-ONLY | `settings/daily-plan-mode/route.ts:13`, :24 |
| settings/digest, digest/feedback, digest/log, digest/outbound | да | superadminError | — | ADMIN-ONLY | `settings/digest/route.ts:21`, `digest/log/route.ts:18` |
| GET/PUT /api/settings/feature-flags | да | superadminError | — | ADMIN-ONLY | `settings/feature-flags/route.ts:12`, :23 |
| **GET /api/settings/metric-colors** | да, 401 | **нет** (PUT — `section.settings`) | нет | **PARTIAL — роут настроек, читаемый любой сессией** | `settings/metric-colors/route.ts:14` `if (!session) return ... 401;` (вместо `permError`), при том что :30 у PUT `permError(session,'section.settings')` |
| GET /api/settings/metrics, PATCH /api/settings/metrics/[id] | да | permError `section.settings` | — | ADMIN-ONLY | `settings/metrics/route.ts:8`; `metrics/[id]/route.ts:15` |
| GET/PUT /api/settings/price-stages | да | superadminError | — | ADMIN-ONLY | `settings/price-stages/route.ts:17`, :46 |
| GET/PUT /api/settings/scoring-weights | да | superadminError | — | ADMIN-ONLY | `settings/scoring-weights/route.ts:16`, :25 |
| GET /api/settings/subscriptions | да, 401 | `action.subscriptions.view_all` ∪ superadmin | только GET существует | ADMIN-ONLY | `settings/subscriptions/route.ts:21-22` |
| GET /api/settings/tables, /tables/[name] | да | permError `section.settings` | — | ADMIN-ONLY | `settings/tables/route.ts:8`; `tables/[name]/route.ts:18` |
| GET/PUT /api/settings/weather-responsibles | да | permError `section.settings` | — | ADMIN-ONLY | `settings/weather-responsibles/route.ts:10`, :17 |
| GET/POST /api/settings/working-calendar | да | permError `section.settings` | — | ADMIN-ONLY | `settings/working-calendar/route.ts:13`, :31 |
| GET/POST /api/admin/daily-report | да | permError `section.settings` | — | ADMIN-ONLY | `admin/daily-report/route.ts:14`, :31 |
| POST /api/admin/digest-test | нет ИЛИ да | Bearer `DIGEST_TEST_TOKEN` **ИЛИ** superadminError | токен в обход сессии; `deliverTo` шлёт цифры любого менеджера кому угодно | PARTIAL | `admin/digest-test/route.ts:35-39` `if (!isValidServiceToken(request)) { ... superadminError ... }` |
| POST /api/admin/rop-digest-test | нет ИЛИ да | Bearer `DIGEST_TEST_TOKEN` ИЛИ superadmin | то же | PARTIAL | `admin/rop-digest-test/route.ts:32-36` |
| POST /api/admin/org-sync | нет ИЛИ да | Bearer `ORG_SYNC_TOKEN` ИЛИ `action.users.manage` | constant-time, пустой env → закрыт | OK | `admin/org-sync/route.ts:24-25`, :42-46 |
| GET/POST /api/admin/metrics, PUT/DELETE /api/admin/metrics/[id] | да | permError `section.metrics` | — | ADMIN-ONLY | `admin/metrics/route.ts:9`, :33 |
| GET /api/admin/org-employees, /api/admin/org-structure | да | permError `action.users.manage` | — | ADMIN-ONLY | `admin/org-employees/route.ts:8`; `admin/org-structure/route.ts:26` |
| GET /api/admin/roles | да, 401 | superadmin ∪ `action.users.manage` | — | ADMIN-ONLY | `admin/roles/route.ts:19-21` |
| POST /api/admin/roles, PATCH/DELETE /api/admin/roles/[id] | да | superadminError | — | ADMIN-ONLY | `admin/roles/route.ts:46`; `roles/[id]/route.ts:8`, :65 |
| GET/POST /api/admin/users, PATCH /api/admin/users/[id], resend, pin-reset, overrides | да | permError `action.users.manage` | — | ADMIN-ONLY | `admin/users/route.ts:27`, :82; `users/[id]/overrides/route.ts:12`, :26 |
| GET/PUT /api/admin/users/[id]/departments | да | superadminError | — | ADMIN-ONLY | `admin/users/[id]/departments/route.ts:17`, :31 |

## Главные дыры

1. **`POST /api/bitrix/events` полностью без аутентификации.** `app/api/bitrix/events/route.ts:33` — ни секрета, ни `application_token`, ни проверки origin; в файле нет ни одного вхождения `token|secret|auth`. При этом обработчик пишет в `bot_inbound_log`, дёргает `handleIncomingBotMessage`, `handleBindDealCommand`, `handleAdviceFeedback` и `recordWeatherAnswer` с произвольным `data[PARAMS][FROM_USER_ID]` — любой из интернета может подделать «ответ менеджера» и привязку сделок. Усугубляется тем, что `proxy.ts:38` `if (pathname.startsWith('/api/')) return NextResponse.next(); // API handles auth itself` — на API middleware не смотрит вообще, PUBLIC-список к ним не применяется, единственная защита — сам роут.

2. **`GET /api/badges/profile?bitrixId=N` — полная «банковская выписка» любого сотрудника любому залогиненному.** `badges/profile/route.ts:21` подставляет произвольный id без `canViewManager`; отдаёт 300 записей `badge_coin_ledger` — суммы, штрафы (`penalty_name`), комментарии, кто начислил (`actor_login`), плюс стаж из `sa.employee_registry`. Снятие гейта задокументировано как решение владельца 05.08 (:12-14), но по заявленной модели МОП не должен видеть штрафы и комментарии коллег.

3. **`POST /api/badges/batch` — балансы валюты и XP всей компании одним запросом.** `badges/batch/route.ts:21,35`: массив до 500 произвольных bitrixId → `getBalances` + `fetchXpBriefs`. Никакого `filterViewableManagers`. МОП может перечислить id 1..500 и снять таблицу балансов.

4. **`GET /api/skills?bitrixId=N` — дерево скиллов и `balance` любого сотрудника.** `skills/route.ts:20-22`: `asked` берётся из query без проверки. То же семейство, что п.2-3: это ровно «командные данные геймификации», которые по модели режутся поддеревом.

5. **`GET /api/badges/collection?bitrixId=N`** — `badges/collection/route.ts:55`, тот же паттерн подстановки чужого id без `canViewManager`.

6. **`GET /api/settings/metric-colors` — единственный роут настроек, открытый обычной сессии.** `settings/metric-colors/route.ts:14` использует голый `if (!session)` 401, тогда как PUT в том же файле (:30) гейтится `permError(session,'section.settings')`. Ассиметрия читается как забытый гейт, а не как решение.

7. **Сервисные Bearer-токены в `admin/digest-test` и `admin/rop-digest-test` шире, чем нужно.** `admin/digest-test/route.ts:35-39`: валидный `DIGEST_TEST_TOKEN` полностью заменяет `superadminError`, а тело принимает `managerBitrixId` + `deliverTo` — то есть держатель одного env-секрета может выгрузить дневные/недельные цифры ЛЮБОГО менеджера в чат ЛЮБОГО получателя. Один и тот же токен обслуживает оба роута (менеджерский и РОПовский дайджест).

Отдельно (не дыры, но отмечаю): `hasFullManagerAccess()` (`lib/org/managerAccess.ts:20-22`) даёт Директору «всё» в `badges/manual` (:16), `badges/payout` (:17), `shop/activate` (:18) и внутри `canViewManager`/`filterViewableManagers`, которыми гейтятся `quests` и `shop`. Также `POST /api/auth/login`, `GET /api/invite/[token]` и `POST /api/invite/[token]/accept` не имеют rate-limit — перебор паролей и инвайт-токенов ничем не ограничен.
