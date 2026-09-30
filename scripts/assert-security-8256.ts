/**
 * Assert-скрипт: исправления по аудиту безопасности 29.09 (задача #8256).
 *
 *  1. SQL-инъекции в отчётах: createdTimeFilter / firstTouchFilter / managerId
 *     из тела запроса и сырые значения метрик конструктора (sqlGen).
 *  2. Эскалация «Администратор» → супер-админ в управлении пользователями.
 *  3. Rate-limit логина (по логину и по IP) + IP клиента из X-Forwarded-For.
 *  5. Вебхук событий Битрикса: fail-closed без BITRIX_EVENTS_APP_TOKEN.
 *
 * Реальные route handlers вызываются без БД: модули-границы (db, session,
 * invites, notifications) подменяются заглушками из scripts/test-stubs/.
 *
 * Запуск (Node 22): NODE_OPTIONS=--experimental-strip-types \
 *   node --import ./scripts/test-stubs/register.mjs scripts/assert-security-8256.ts
 */
import { NextRequest } from 'next/server';
import { stub } from './test-stubs/state.ts';
import { createdTimeWhere, firstTouchWhere, isCreatedTimeFilter, isFirstTouchFilter } from '../lib/metrics/offHoursFilters.ts';
import { reportFiltersError } from '../lib/reports/requestValidation.ts';
import { resolveFilterClause, buildCollectedSQL } from '../lib/metrics/sqlGen.ts';
import { metricDefinitionError } from '../lib/metrics/metricValidation.ts';
import { createLoginLimiter, MemoryRateStore } from '../lib/auth/loginRateLimit.ts';
import { clientIpFromHeaders } from '../lib/http/clientIp.ts';
import { authenticateBitrixEvent } from '../lib/bitrix/eventsAuth.ts';
import type { Metric, MetricFilter } from '../lib/metrics/types.ts';

let failures = 0;
let passed = 0;
function check(cond: boolean, label: string) {
  if (cond) { passed++; return; }
  failures++;
  console.error(`FAIL ${label}`);
}
function throws(fn: () => unknown): boolean {
  try { fn(); return false; } catch { return true; }
}

const INJECTION = "business_hours' OR pg_sleep(5) IS NULL OR 'a'='a";

// ── 1. SQL-инъекции ─────────────────────────────────────────────────────────
{
  check(isCreatedTimeFilter('weekend') && isCreatedTimeFilter('all'), 'createdTimeFilter: легитимные значения проходят');
  check(!isCreatedTimeFilter(INJECTION) && !isCreatedTimeFilter(1) && !isCreatedTimeFilter(null), 'createdTimeFilter: инъекция/не-строка отвергаются');
  check(isFirstTouchFilter('off_hours') && !isFirstTouchFilter(INJECTION), 'firstTouchFilter: allowlist');

  const ok = createdTimeWhere('d', 'business_hours');
  check(ok.includes("= 'business_hours'"), 'createdTimeWhere: легитимный фильтр даёт условие');
  check(createdTimeWhere('d', 'all') === '' && createdTimeWhere('d', undefined) === '', 'createdTimeWhere: all/undefined — без условия');
  check(throws(() => createdTimeWhere('d', INJECTION as never)), 'createdTimeWhere: инъекционная строка — исключение, в SQL не попадает');
  check(throws(() => firstTouchWhere('d', INJECTION as never)), 'firstTouchWhere: неизвестное значение — исключение');

  check(reportFiltersError({}) === null, 'reportFiltersError: пустое тело ок');
  check(reportFiltersError({ createdTimeFilter: 'weekend', firstTouchFilter: 'business_hours', managerId: '123' }) === null, 'reportFiltersError: легитимные значения ок');
  check(reportFiltersError({ managerId: 42 }) === null, 'reportFiltersError: managerId числом ок');
  check(reportFiltersError({ createdTimeFilter: INJECTION }) !== null, 'reportFiltersError: createdTimeFilter-инъекция → ошибка');
  check(reportFiltersError({ firstTouchFilter: INJECTION }) !== null, 'reportFiltersError: firstTouchFilter-инъекция → ошибка');
  check(reportFiltersError({ managerId: '1 OR 1=1' }) !== null, 'reportFiltersError: managerId-инъекция → ошибка');
  check(reportFiltersError({ managerId: '' }) === null && reportFiltersError({ managerId: null }) === null, 'reportFiltersError: пустой managerId = не задан');

  // sqlGen: значения фильтров метрик экранируются, имена колонок — только идентификаторы.
  const f = (x: Partial<MetricFilter>): MetricFilter => ({ field: 'stage_id', op: 'eq', value: 'X', ...x } as MetricFilter);
  check(resolveFilterClause(f({ value: 'WON' }), 'd') === "d.stage_id = 'WON'", 'sqlGen eq: обычное значение без изменений');
  check(resolveFilterClause(f({ value: "a' OR '1'='1" }), 'd') === "d.stage_id = 'a'' OR ''1''=''1'", 'sqlGen eq: кавычка экранирована');
  check(resolveFilterClause(f({ op: 'in', value: ['A', "b'c", 3] as never }), 'd') === "d.stage_id IN ('A', 'b''c', 3)", 'sqlGen in: элементы экранированы');
  check(resolveFilterClause(f({ field: 'event_type', value: "x') OR ('1'='1" }), 'd').includes("event_type = 'x'') OR (''1''=''1'"), 'sqlGen event_type: экранировано');
  check(throws(() => resolveFilterClause(f({ field: 'stage_id = stage_id OR 1' }), 'd')), 'sqlGen: поле-не-идентификатор — исключение');
  check(throws(() => resolveFilterClause(f({ value: { x: 1 } as never }), 'd')), 'sqlGen: значение-объект — исключение');
  check(throws(() => resolveFilterClause(f({ op: 'in', value: [Number.NaN] as never }), 'd')), 'sqlGen: NaN — исключение');

  const metric = (x: Partial<Metric>): Metric => ({
    id: 'deals_cnt', metricType: 'collected', source: 'deals', aggFn: 'count_distinct',
    aggField: 'deal_id', dateField: 'created_at', filters: [], ...x,
  } as Metric);
  const dim = { idExpr: 'd.current_manager_id::text', groupBy: 'd.current_manager_id' };
  check(buildCollectedSQL([metric({})], dim).includes('AS deals_cnt'), 'buildCollectedSQL: легитимная метрика');
  check(throws(() => buildCollectedSQL([metric({ id: 'x FROM pg_shadow --' })], dim)), 'buildCollectedSQL: id метрики не идентификатор — исключение');
  check(throws(() => buildCollectedSQL([metric({ aggField: 'deal_id) FROM users --' })], dim)), 'buildCollectedSQL: agg_field — исключение');
  check(throws(() => buildCollectedSQL([metric({ dateField: 'created_at >= now() OR true --' })], dim)), 'buildCollectedSQL: date_field — исключение');

  // Валидация на записи метрики (admin/metrics POST/PUT).
  check(metricDefinitionError({ id: 'deals_cnt', agg_field: 'deal_id', date_field: 'created_at', filters: [{ field: 'stage_id', op: 'in', value: ['A', 'B'] }] }, { requireId: true }) === null, 'metricDefinitionError: легитимная метрика');
  check(metricDefinitionError({ id: 'x; drop', filters: [] }, { requireId: true }) !== null, 'metricDefinitionError: плохой id');
  check(metricDefinitionError({ agg_field: 'a b', filters: [] }, { requireId: false }) !== null, 'metricDefinitionError: плохой agg_field');
  check(metricDefinitionError({ filters: [{ field: 'x', op: 'raw', value: 1 }] }, { requireId: false }) !== null, 'metricDefinitionError: неизвестный op');
  check(metricDefinitionError({ filters: [{ field: 'x', op: 'eq', value: { a: 1 } }] }, { requireId: false }) !== null, 'metricDefinitionError: value-объект');
  check(metricDefinitionError({ filters: [{ field: '_has_call', op: 'eq', value: true }] }, { requireId: false }) === null, 'metricDefinitionError: виртуальное поле и boolean ок');
}

// ── 1б. Роут /api/reports/run: инъекция → 400 до SQL ─────────────────────────
const ADMIN_ROLE_SESSION = {
  id: 'u-admin', login: 'admin', displayName: 'Админ', isSuperadmin: false,
  permissions: ['action.users.manage', 'section.all'], sectionOverrides: [], roleName: 'Администратор',
  avatarUrl: null, bitrixUserId: '10', uiMode: null,
};
const SUPERADMIN_SESSION = { ...ADMIN_ROLE_SESSION, id: 'u-super', login: 'root', isSuperadmin: true, roleName: null };
const SUPER_TARGET = 'u-target-super';
const PLAIN_TARGET = 'u-target-plain';

function jsonReq(url: string, method: string, body?: unknown, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest(new URL(url, 'http://localhost'), {
    method, headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
const params = (id: string) => ({ params: Promise.resolve({ id }) });

function usersDb(sql: string, p: unknown[]) {
  const id = p[p.length - 1];
  if (/is_superadmin/i.test(sql) && /FROM users WHERE id/i.test(sql)) {
    const pid = p[0];
    if (pid === SUPER_TARGET) return { rows: [{ is_superadmin: true }] };
    if (pid === PLAIN_TARGET || pid === ADMIN_ROLE_SESSION.id) return { rows: [{ is_superadmin: false }] };
    return { rows: [] };
  }
  if (/FROM roles WHERE id/i.test(sql)) return { rows: [{ id: p[0] }] };
  if (/SELECT display_name, bitrix_user_id, is_active FROM users/i.test(sql)) return { rows: [{ display_name: 'X', bitrix_user_id: '77', is_active: false }] };
  if (/SELECT id, bitrix_user_id, pin_hash FROM users/i.test(sql)) return { rows: [{ id: p[0], bitrix_user_id: '77', pin_hash: 'h' }] };
  if (/SELECT section_overrides FROM users/i.test(sql)) return { rows: [{ section_overrides: [] }] };
  if (/^\s*UPDATE users/i.test(sql)) return { rows: [{ id }] };
  return { rows: [] };
}

{
  const run = await import('../app/api/reports/run/route.ts');
  stub().session = ADMIN_ROLE_SESSION;
  stub().queries = [];
  stub().query = () => ({ rows: [] });
  const period = { from: '2026-09-01', to: '2026-09-30' };
  const res = await run.POST(jsonReq('/api/reports/run', 'POST', { period, comparisonPeriod: period, createdTimeFilter: INJECTION }));
  check(res.status === 400 && String((await res.json()).error).includes('createdTimeFilter'), `/api/reports/run createdTimeFilter-инъекция → 400 (получено ${res.status})`);
  check(stub().queries.length === 0, '/api/reports/run: до SQL не дошло');
  const res2 = await run.POST(jsonReq('/api/reports/run', 'POST', { period, comparisonPeriod: period, managerId: '1 OR 1=1' }));
  check(res2.status === 400 && String((await res2.json()).error).includes('managerId'), `/api/reports/run managerId-инъекция → 400 (получено ${res2.status})`);

  for (const path of ['../app/api/reports/by-periods/route.ts', '../app/api/reports/metric-series/route.ts']) {
    const mod = await import(path);
    stub().queries = [];
    const r = await mod.POST(jsonReq('/x', 'POST', { period, comparisonPeriod: period, createdTimeFilter: INJECTION, metricId: 'deals_cnt', metricIds: ['deals_cnt'] }));
    check(r.status === 400 && String((await r.json()).error).includes('createdTimeFilter'), `${path} createdTimeFilter-инъекция → 400 (получено ${r.status})`);
    check(stub().queries.length === 0, `${path}: до SQL не дошло`);
  }
}

// ── 2. Эскалация «Администратор» → супер-админ ───────────────────────────────
{
  stub().query = usersDb;
  const patch = await import('../app/api/admin/users/[id]/route.ts');
  const resend = await import('../app/api/admin/users/[id]/resend/route.ts');
  const pinReset = await import('../app/api/admin/users/[id]/pin-reset/route.ts');
  const overrides = await import('../app/api/admin/users/[id]/overrides/route.ts');

  const asAdmin = () => { stub().session = ADMIN_ROLE_SESSION; stub().queries = []; stub().invites = []; };
  const asSuper = () => { stub().session = SUPERADMIN_SESSION; stub().queries = []; stub().invites = []; };
  const mutated = () => stub().queries.some(q => /^\s*(UPDATE|INSERT|DELETE)/i.test(q.sql));

  asAdmin();
  let r = await patch.PATCH(jsonReq('/x', 'PATCH', { is_active: false }), params(SUPER_TARGET));
  check(r.status === 403 && !mutated(), `PATCH is_active супер-админа под «Администратор» → 403 (получено ${r.status})`);
  asAdmin();
  r = await patch.PATCH(jsonReq('/x', 'PATCH', { role_id: 'r1' }), params(SUPER_TARGET));
  check(r.status === 403 && !mutated(), `PATCH role_id супер-админа под «Администратор» → 403 (получено ${r.status})`);
  asAdmin();
  r = await patch.PATCH(jsonReq('/x', 'PATCH', { role_id: 'r1' }), params(ADMIN_ROLE_SESSION.id));
  check(r.status === 403 && !mutated(), `PATCH смена СВОЕЙ роли под «Администратор» → 403 (получено ${r.status})`);
  asAdmin();
  r = await patch.PATCH(jsonReq('/x', 'PATCH', { is_active: false }), params(PLAIN_TARGET));
  check(r.status === 200 && mutated(), `PATCH обычного пользователя под «Администратор» → 200 (получено ${r.status})`);
  asSuper();
  r = await patch.PATCH(jsonReq('/x', 'PATCH', { is_active: false }), params(SUPER_TARGET));
  check(r.status === 200, `PATCH супер-админа под супер-админом → 200 (получено ${r.status})`);

  asAdmin();
  r = await resend.POST(jsonReq('/x', 'POST'), params(SUPER_TARGET));
  check(r.status === 403 && stub().invites.length === 0, `resend супер-админу под «Администратор» → 403 (получено ${r.status})`);
  asAdmin();
  r = await resend.POST(jsonReq('/x', 'POST'), params(PLAIN_TARGET));
  let body = await r.json();
  check(r.status === 200 && stub().invites.length === 1, `resend обычному под «Администратор» → 200 (получено ${r.status})`);
  check(!('inviteLink' in body) && !JSON.stringify(body).includes('SECRET-LINK'), 'resend под «Администратор»: inviteLink в ответе нет');
  asSuper();
  r = await resend.POST(jsonReq('/x', 'POST'), params(PLAIN_TARGET));
  body = await r.json();
  check(r.status === 200 && body.inviteLink === 'https://example.test/invite/SECRET-LINK', 'resend под супер-админом: ссылка отдаётся (фолбэк режима тишины бота)');

  asAdmin();
  r = await pinReset.POST(jsonReq('/x', 'POST'), params(SUPER_TARGET));
  check(r.status === 403 && !mutated(), `pin-reset супер-админа под «Администратор» → 403 (получено ${r.status})`);
  asAdmin();
  r = await pinReset.POST(jsonReq('/x', 'POST'), params(PLAIN_TARGET));
  check(r.status === 200, `pin-reset обычного под «Администратор» → 200 (получено ${r.status})`);

  asAdmin();
  r = await overrides.PUT(jsonReq('/x', 'PUT', { sectionOverrides: [] }), params(SUPER_TARGET));
  check(r.status === 403 && !mutated(), `overrides PUT супер-админа под «Администратор» → 403 (получено ${r.status})`);
  asAdmin();
  r = await overrides.PUT(jsonReq('/x', 'PUT', { sectionOverrides: [] }), params(PLAIN_TARGET));
  check(r.status === 200, `overrides PUT обычного под «Администратор» → 200 (получено ${r.status})`);
}

// ── 3. Rate-limit логина ─────────────────────────────────────────────────────
{
  check(clientIpFromHeaders(new Headers({ 'x-forwarded-for': '6.6.6.6, 1.2.3.4' })) === '1.2.3.4', 'clientIp: берётся правый адрес XFF (добавленный Caddy), левый подделан');
  check(clientIpFromHeaders(new Headers({ 'x-forwarded-for': '1.2.3.4' })) === '1.2.3.4', 'clientIp: один адрес');
  check(clientIpFromHeaders(new Headers({ 'x-forwarded-for': '9.9.9.9, 1.2.3.4, 10.0.0.1' }), 2) === '1.2.3.4', 'clientIp: TRUSTED_PROXY_HOPS=2');
  check(clientIpFromHeaders(new Headers()) === null, 'clientIp: без XFF — null');

  let now = 1_000_000;
  const lim = createLoginLimiter({ store: new MemoryRateStore(() => now), windowSec: 900, maxPerLogin: 3, maxPerIp: 5 });
  check((await lim.blocked('1.1.1.1', 'bob')) === null, 'limiter: изначально не заблокирован');
  for (let i = 0; i < 3; i++) await lim.recordFailure('1.1.1.1', 'bob');
  const b = await lim.blocked('2.2.2.2', 'BOB ');
  check(b !== null && b.retryAfterSec > 0 && b.retryAfterSec <= 900, 'limiter: 3 ошибки по логину — блок и с другого IP, регистр/пробелы логина не важны');
  check((await lim.blocked('1.1.1.1', 'alice')) === null, 'limiter: другой логин с того же IP ещё не заблокирован (IP-лимит 5)');
  for (let i = 0; i < 2; i++) await lim.recordFailure('1.1.1.1', `u${i}`);
  check((await lim.blocked('1.1.1.1', 'carol')) !== null, 'limiter: 5 ошибок с IP — блок любого логина с этого IP');
  now += 901_000;
  check((await lim.blocked('1.1.1.1', 'bob')) === null, 'limiter: по истечении окна снова можно');
  await lim.recordFailure('3.3.3.3', 'dan');
  await lim.recordFailure('3.3.3.3', 'dan');
  await lim.recordSuccess('3.3.3.3', 'dan');
  await lim.recordFailure('3.3.3.3', 'dan');
  check((await lim.blocked('3.3.3.3', 'dan')) === null, 'limiter: успешный вход сбрасывает счётчик логина');

  // Роут логина целиком: 10 неверных паролей → 11-й запрос 429 даже с верным паролем.
  const bcrypt = (await import('bcryptjs')).default;
  const hash = await bcrypt.hash('right-pass', 4);
  stub().session = null;
  stub().query = (sql: string, p: unknown[]) => (/FROM users WHERE login/i.test(sql) && p[0] === 'victim'
    ? { rows: [{ id: 'u-v', password_hash: hash, is_active: true }] } : { rows: [] });
  const login = await import('../app/api/auth/login/route.ts');
  const loginReq = (pw: string, ip: string, who = 'victim') =>
    jsonReq('/api/auth/login', 'POST', { login: who, password: pw }, { 'x-forwarded-for': ip });
  const ok = await login.POST(loginReq('right-pass', '5.5.5.5'));
  check(ok.status === 200, `login: верный пароль → 200 (получено ${ok.status})`);
  const statuses: number[] = [];
  for (let i = 0; i < 10; i++) statuses.push((await login.POST(loginReq('wrong', `7.7.7.${i}`))).status);
  check(statuses.every(s => s === 401), `login: 10 неверных → 401 (получено ${statuses.join(',')})`);
  const blocked = await login.POST(loginReq('right-pass', '8.8.8.8'));
  check(blocked.status === 429 && !!blocked.headers.get('retry-after'), `login: 11-я попытка на логин → 429 с Retry-After (получено ${blocked.status})`);
  const ghost = await login.POST(loginReq('x', '5.5.5.6', 'nobody'));
  check(ghost.status === 401, 'login: несуществующий логин → 401');
}

// ── 5. Вебхук событий Битрикса: fail-closed ──────────────────────────────────
{
  const data = { 'auth[domain]': 'td.monolit-crm.ru', 'auth[application_token]': 'tok123' };
  check(!authenticateBitrixEvent(data, {}).ok, 'bitrix events: env не задан → отказ (fail-closed)');
  check(!authenticateBitrixEvent(data, { BITRIX_EVENTS_APP_TOKEN: '' }).ok, 'bitrix events: пустой env → отказ');
  check(authenticateBitrixEvent(data, { BITRIX_EVENTS_APP_TOKEN: 'tok123' }).ok, 'bitrix events: верный токен → принято');
  check(!authenticateBitrixEvent(data, { BITRIX_EVENTS_APP_TOKEN: 'other' }).ok, 'bitrix events: неверный токен → отказ');
  check(!authenticateBitrixEvent({ ...data, 'auth[domain]': 'evil.example' }, { BITRIX_EVENTS_APP_TOKEN: 'tok123' }).ok, 'bitrix events: чужой домен → отказ');
  check(authenticateBitrixEvent({ auth: { domain: 'https://td.monolit-crm.ru/', application_token: 'tok123' } }, { BITRIX_EVENTS_APP_TOKEN: 'tok123' }).ok, 'bitrix events: JSON-форма auth');

  const events = await import('../app/api/bitrix/events/route.ts');
  const prev = process.env.BITRIX_EVENTS_APP_TOKEN;
  delete process.env.BITRIX_EVENTS_APP_TOKEN;
  const form = new URLSearchParams({ event: 'ONIMBOTMESSAGEADD', ...data });
  const req = new NextRequest(new URL('/api/bitrix/events', 'http://localhost'), {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form.toString(),
  });
  stub().queries = [];
  const logged: string[] = [];
  const origWarn = console.warn, origErr = console.error, origLog = console.log;
  console.warn = console.error = console.log = (...a: unknown[]) => { logged.push(a.map(String).join(' ')); };
  const r = await events.POST(req);
  process.env.BITRIX_EVENTS_APP_TOKEN = 'another-token';
  const mk = () => new NextRequest(new URL('/api/bitrix/events', 'http://localhost'), {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form.toString(),
  });
  const r2 = await events.POST(mk());
  process.env.BITRIX_EVENTS_APP_TOKEN = 'tok123';
  const r4 = await events.POST(mk());
  delete process.env.BITRIX_EVENTS_APP_TOKEN;
  const r3 = await events.POST(mk());
  console.warn = origWarn; console.error = origErr; console.log = origLog;
  check(r.status === 403 && r3.status === 403, `POST /api/bitrix/events без env → 403 (получено ${r.status}, ${r3.status})`);
  check(r2.status === 403, `POST /api/bitrix/events с неверным токеном → 403 (получено ${r2.status})`);
  check(r4.status === 200, `POST /api/bitrix/events с верным токеном → 200 (получено ${r4.status})`);
  check(logged.length > 0 && logged.every(l => !l.includes('tok123')), 'bitrix events: полный токен в лог не пишется');
  check(logged.some(l => l.includes('tok1…')), 'bitrix events: в логе только первые 4 символа токена');
  if (prev !== undefined) process.env.BITRIX_EVENTS_APP_TOKEN = prev;
}

console.log(`\n${passed} passed, ${failures} failed`);
if (failures) process.exit(1);
