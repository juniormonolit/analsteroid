// Инструменты MCP-сервера Монолитики (задача владельца 22.10). Принцип: модель НЕ пишет SQL —
// вызывает эти функции, а они зовут ТЕ ЖЕ движки, что и экраны (отчёт «по менеджерам»,
// «Мой отчёт», декомпозиция, рейтинг, разгрузка). Цифра в Claude = цифра на экране.
//
// Права: каждый инструмент режет данные срезом сессии (lib/org/sessionScope.ts) — директор
// филиала видит свой филиал, как в интерфейсе. Чего НЕТ и не будет без отдельного решения:
// произвольного SQL, контактов/телефонов клиентов, звонков и расшифровок (va.*), записи.
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SessionUser } from '@/lib/auth/session';
import { hasPerm } from '@/lib/auth/perms';
import { systemDb } from '@/lib/db/clients';
import { loadMetrics, resolveMetricIds, withDependencies } from '@/lib/metrics/catalog';
import type { Metric, ReportRow } from '@/lib/metrics/types';
import { getSessionScope, scopeDeptIdsBitrix } from '@/lib/org/sessionScope';
import { hasFullManagerAccess } from '@/lib/org/managerAccess';
import { fetchByManagers } from '@/features/reports/engine/byManagers';
import { fetchByProductGroups } from '@/features/reports/engine/byProductGroups';
import { enrichManagerRowsForMetrics } from '@/features/reports/engine/enrichManagerRows';
import { computeCalculated, computeTotals } from '@/features/reports/engine/calculated';
import { buildMyReportSpec, MyReportInputError } from '@/lib/reports-builder/buildMyReport';
import { availableEntities, type EntityInput } from '@/lib/reports-builder/entities';
import { LEAD_METRICS } from '@/lib/reports-builder/presets';
import { buildReportText } from '@/features/reports-builder/engine/buildReportText';
import { getDecompositionPlanFact } from '@/features/decomposition/engine/planFact';
import { computeManagerRatings } from '@/features/manager-card/engine/ratings';
import { getOffloadDeals } from '@/features/offload/engine/offload';
import { publicBaseUrl } from './oauth';
import {
  ToolInputError, findDepartments, findManagers, loadGlossary, loadOrg, parsePeriod,
  resolveProductGroup, visibleManagers, type OrgManager,
} from './context';

// ── Общее ──────────────────────────────────────────────────────────────────────────

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('YYYY-MM-DD');

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };

const url = (path: string) => `${publicBaseUrl()}${path}`;

function round(v: number | null | undefined): number | null {
  if (v === null || v === undefined || !Number.isFinite(v)) return null;
  return Math.abs(v) >= 100 ? Math.round(v) : Math.round(v * 100) / 100;
}

const UNIT: Record<string, string> = { int: 'шт', decimal: 'число', money: '₽', percent: '%', months: 'мес' };

function metricMeta(m: Metric) {
  return { id: m.id, name: m.nameRu, unit: UNIT[m.dataType] ?? m.dataType };
}

/** Обёртка: журнал вызова (mcp_tool_calls), понятная ошибка вместо падения сессии Claude. */
async function run(session: SessionUser, tool: string, args: unknown, fn: () => Promise<unknown>): Promise<ToolResult> {
  const started = Date.now();
  let ok = true;
  let error: string | null = null;
  try {
    const data = await fn();
    return { content: [{ type: 'text', text: typeof data === 'string' ? data : JSON.stringify(data) }] };
  } catch (e) {
    ok = false;
    const expected = e instanceof ToolInputError || e instanceof MyReportInputError;
    error = e instanceof Error ? e.message : String(e);
    if (!expected) console.error(`[mcp] ${tool} failed:`, e);
    return { content: [{ type: 'text', text: expected ? error : `Ошибка расчёта: ${error}` }], isError: true };
  } finally {
    systemDb().query(
      `INSERT INTO mcp_tool_calls (user_id, tool, args, ok, error, duration_ms) VALUES ($1, $2, $3, $4, $5, $6)`,
      [session.id, tool, JSON.stringify(args ?? null), ok, error, Date.now() - started],
    ).catch(() => { /* журнал не должен ронять ответ */ });
  }
}

// ── Фильтры get_metrics ────────────────────────────────────────────────────────────

interface ResolvedFilters {
  departmentIds: string[] | undefined; // bitrix id для движков; undefined — без ограничения
  managerIds: Set<string> | null;      // пост-фильтр строк; null — все видимые
  productGroupIds: string[] | undefined;
  applied: Record<string, unknown>;
}

async function resolveFilters(
  session: SessionUser,
  f: { managers?: string[]; departments?: string[]; branch?: string; product_group?: string },
): Promise<ResolvedFilters & { org: Map<string, OrgManager> }> {
  const scope = await getSessionScope(session);
  const org = await loadOrg();
  const visible = visibleManagers(org, scope);
  const applied: Record<string, unknown> = {};
  if (scope.kind !== 'all') applied.access = 'Данные ограничены вашей зоной доступа в Монолитике';

  let managerIds: Set<string> | null = scope.kind === 'all' ? null : new Set(visible.map(m => m.managerId));

  if (f.managers?.length) {
    const picked = new Set<string>();
    for (const q of f.managers) {
      const found = findManagers(visible, q);
      if (found.length === 0) throw new ToolInputError(`Менеджер «${q}» не найден среди доступных вам. Уточните через find_org.`);
      if (found.length > 5) throw new ToolInputError(`«${q}» — слишком много совпадений (${found.length}). Уточните имя.`);
      found.forEach(m => picked.add(m.managerId));
    }
    managerIds = picked;
    applied.managers = [...picked].map(id => org.get(id)?.name ?? id);
  }

  let requestedBitrix: string[] | undefined;
  if (f.departments?.length) {
    const found = (await Promise.all(f.departments.map(findDepartments))).flat();
    if (found.length === 0) throw new ToolInputError(`Отделы не найдены: ${f.departments.join(', ')}. Список — find_org.`);
    requestedBitrix = [...new Set(found.map(d => d.bitrixId))];
    applied.departments = [...new Set(found.map(d => d.name))];
  }
  let departmentIds: string[] | undefined;
  if (scope.kind === 'self') {
    departmentIds = undefined; // режем по менеджерам ниже
    if (requestedBitrix) throw new ToolInputError('Вам доступны только собственные показатели — фильтр по отделам недоступен.');
  } else {
    const eff = await scopeDeptIdsBitrix(scope, requestedBitrix);
    if (eff && eff.length === 0) throw new ToolInputError('Запрошенные отделы вне вашей зоны доступа.');
    departmentIds = eff ?? undefined;
  }

  if (f.branch) {
    const b = f.branch.toLowerCase();
    const inBranch = new Set([...org.values()].filter(m => (m.branch ?? '').toLowerCase().includes(b)).map(m => m.managerId));
    if (inBranch.size === 0) throw new ToolInputError(`Филиал «${f.branch}» не найден. Филиалы: ${[...new Set([...org.values()].map(m => m.branch))].join(', ')}`);
    managerIds = managerIds ? new Set([...managerIds].filter(id => inBranch.has(id))) : inBranch;
    applied.branch = f.branch;
  }

  let productGroupIds: string[] | undefined;
  if (f.product_group) {
    const pg = await resolveProductGroup(f.product_group);
    if (!pg) throw new ToolInputError(`Товарная группа «${f.product_group}» не распознана. Посмотрите explain_term или назовите группу точнее.`);
    productGroupIds = pg.kcGroups.map(g => g.id);
    applied.product_group = { asked: f.product_group, understood_as: pg.understoodAs, groups: pg.kcGroups.map(g => g.name) };
  }

  return { departmentIds, managerIds, productGroupIds, applied, org };
}

// ── Расчёт метрик ──────────────────────────────────────────────────────────────────

type GroupBy = 'manager' | 'department' | 'branch' | 'product_group' | 'total';

async function computeMetricRows(opts: {
  session: SessionUser;
  metrics: Metric[];
  withDeps: Metric[];
  from: string; to: string;
  groupBy: GroupBy;
  filters: ResolvedFilters & { org: Map<string, OrgManager> };
  clientType: 'all' | 'b2c' | 'b2b';
}): Promise<{ key: string; label: string; extra?: Record<string, string | null>; values: Record<string, number | null> }[]> {
  const { metrics, withDeps, filters, groupBy, org } = { ...opts, org: opts.filters.org };
  const period = parsePeriod(opts.from, opts.to);
  const calculated = withDeps.filter(m => m.metricType === 'calculated');
  const pick = (vals: Record<string, number | null>) =>
    Object.fromEntries(metrics.map(m => [m.id, round(vals[m.id])]));

  if (groupBy === 'product_group') {
    const rows = await fetchByProductGroups({
      period,
      clientType: opts.clientType,
      productGroupMode: 'kc',
      productGroupIds: filters.productGroupIds,
      departmentIds: filters.departmentIds,
      managerIds: filters.managerIds ? [...filters.managerIds] : undefined,
    });
    return rows.map(r => ({
      key: r.dimensionId, label: r.dimensionName,
      values: pick(computeCalculated(r.metrics, calculated)),
    }));
  }

  const raw = await fetchByManagers({
    period,
    clientType: opts.clientType,
    accountType: 'managers',
    departmentIds: filters.departmentIds,
    productGroupMode: 'kc',
    productGroupIds: filters.productGroupIds,
  });
  const scoped = filters.managerIds ? raw.filter(r => filters.managerIds!.has(r.dimensionId)) : raw;
  // Звонки/активность/стадии — тем же обогатителем, что карточка менеджера и рейтинг.
  const enriched = await enrichManagerRowsForMetrics(scoped, period, metrics.map(m => m.id));
  const rows: ReportRow[] = enriched.map(r => ({ ...r, metrics: computeCalculated(r.metrics, calculated) }));

  if (groupBy === 'manager') {
    return rows.map(r => {
      const o = org.get(r.dimensionId);
      return {
        key: r.dimensionId, label: o?.name ?? r.dimensionName,
        extra: { department: o?.department ?? r.teamName ?? null, branch: o?.branch ?? null },
        values: pick(r.metrics),
      };
    });
  }

  // Агрегаты: суммы collected + пересчёт calculated (computeTotals, как строка «Итого» в отчёте).
  // Не-суммируемые collected (медианы, средние) в агрегате честно пустые.
  const nonAdditive = new Set(withDeps.filter(m => m.metricType === 'collected' && m.aggregationFn !== 'sum').map(m => m.id));
  const groups = new Map<string, { label: string; rows: ReportRow[] }>();
  for (const r of rows) {
    const o = org.get(r.dimensionId);
    const [key, label] = groupBy === 'total' ? ['total', 'Итого']
      : groupBy === 'branch' ? [o?.branch ?? '—', o?.branch ?? '—']
      : [o?.departmentUuid ?? r.teamId ?? '—', o?.department ?? r.teamName ?? '—'];
    if (!groups.has(key)) groups.set(key, { label, rows: [] });
    groups.get(key)!.rows.push(r);
  }
  return [...groups].map(([key, g]) => {
    const totals = computeTotals(g.rows, withDeps);
    for (const id of nonAdditive) totals[id] = null;
    return { key, label: g.label, extra: { managers: String(g.rows.length) }, values: pick(totals) };
  });
}

// ── Регистрация ────────────────────────────────────────────────────────────────────

export function registerTools(server: McpServer, session: SessionUser) {
  // 1. Каталог метрик
  server.registerTool('list_metrics', {
    title: 'Каталог метрик',
    description:
      'Список метрик Монолитики с описанием «как считается». Вызывай ПЕРЕД get_metrics, чтобы взять точные id. ' +
      'Метрики идут тройками: первичные / повторные / все (суффиксы _primary/_repeat или без). ' +
      'query — поиск по названию/описанию (например «конверсия», «средний чек», «отгрузки»).',
    inputSchema: {
      query: z.string().optional().describe('Поиск по названию и описанию'),
      category: z.string().optional().describe('Категория метрик'),
    },
    annotations: READ_ONLY,
  }, async ({ query, category }) => run(session, 'list_metrics', { query, category }, async () => {
    const all = (await loadMetrics()).filter(m => m.isActive && !m.isHiddenInUi && !m.isTest);
    // Мягкий поиск: метрика подходит, если совпало хоть одно слово; выше — где совпало больше
    // и где совпадение в названии. «Конверсия» ищет и «CR» — так названы конверсии в каталоге.
    const words = (query ?? '').toLowerCase().replace(/ё/g, 'е').split(/\s+/).filter(w => w.length > 1)
      .map(w => (w.length > 5 ? w.slice(0, -2) : w));
    const variants = (w: string) => (w.startsWith('конверс') ? [w, 'cr '] : [w]);
    const scored = all
      .filter(m => !category || (m.category ?? '').toLowerCase() === category.toLowerCase())
      .map(m => {
        const name = `${m.nameRu} ${m.nameShortRu ?? ''} `.toLowerCase().replace(/ё/g, 'е');
        const hay = `${m.id} ${name} ${m.humanDescription ?? m.description ?? ''} ${m.tags.join(' ')}`.toLowerCase().replace(/ё/g, 'е');
        let score = 0;
        for (const w of words) {
          const vs = variants(w);
          if (vs.some(v => name.includes(v))) score += 3;
          else if (vs.some(v => hay.includes(v))) score += 1;
        }
        return { m, score };
      })
      .filter(x => !words.length || x.score > 0)
      .sort((a, b) => b.score - a.score);
    const found = scored.map(x => x.m);
    const compact = !words.length && !category;
    return {
      total: found.length,
      categories: compact ? [...new Set(all.map(m => m.category ?? '—'))] : undefined,
      metrics: found.slice(0, compact ? 400 : 80).map(m => ({
        ...metricMeta(m),
        category: m.category,
        ...(compact ? {} : {
          how: m.humanDescription || m.description || undefined,
          formula: m.formulaHuman || undefined,
          type: m.metricType,
        }),
      })),
      hint: compact ? 'Для описания «как считается» вызови list_metrics с query.' : undefined,
    };
  }));

  // 2. Словарь
  server.registerTool('explain_term', {
    title: 'Словарь и товарные группы',
    description:
      'Переводит сленг и слова человека в термины Монолитики: «газик» → товарная группа «Газобетон», ' +
      '«повторка» → повторные продажи, «Париж» → самовывоз. Вызывай, когда в вопросе есть товар, сленг или ' +
      'аббревиатура. Без term — весь словарь.',
    inputSchema: { term: z.string().optional().describe('Слово или фраза; пусто — весь словарь') },
    annotations: READ_ONLY,
  }, async ({ term }) => run(session, 'explain_term', { term }, async () => {
    const glossary = await loadGlossary();
    if (!term) return { glossary: glossary.map(g => ({ term: g.term, meaning: g.meaning })) };
    const q = term.toLowerCase().replace(/ё/g, 'е').trim();
    const hits = glossary.filter(g => g.term.toLowerCase().replace(/ё/g, 'е') === q);
    const pg = await resolveProductGroup(term);
    if (!hits.length && !pg) {
      return { term, found: false, hint: 'Не знаю такого слова — уточни у человека, что он имеет в виду, и не угадывай.' };
    }
    return {
      term,
      glossary: hits.map(g => ({ meaning: g.meaning, kind: g.kind })),
      product_groups: pg ? { understood_as: pg.understoodAs, groups: pg.kcGroups.map(g => g.name), via: pg.via } : undefined,
      hint: pg ? 'Передай это слово в параметр product_group инструментов get_metrics / get_open_deals.' : undefined,
    };
  }));

  // 3. Оргструктура
  server.registerTool('find_org', {
    title: 'Люди и отделы',
    description:
      'Поиск менеджеров и отделов (в пределах доступа). Без query — список отделов и филиалов. ' +
      'С query — менеджеры и отделы, чьё имя/название содержит слова запроса.',
    inputSchema: { query: z.string().optional().describe('Имя, фамилия, логин или название отдела') },
    annotations: READ_ONLY,
  }, async ({ query }) => run(session, 'find_org', { query }, async () => {
    const scope = await getSessionScope(session);
    const org = await loadOrg();
    const visible = visibleManagers(org, scope);
    if (!query) {
      const avail = await availableEntities(session);
      const byDept = new Map<string, number>();
      for (const m of visible) byDept.set(m.department ?? '—', (byDept.get(m.department ?? '—') ?? 0) + 1);
      return {
        departments: avail.departments.map(d => ({ name: d.name, managers: byDept.get(d.name) ?? 0 })),
        branches: avail.branches.map(b => b.name),
        managers_visible: visible.length,
      };
    }
    const managers = findManagers(visible, query).slice(0, 30);
    const depts = (await findDepartments(query)).slice(0, 15);
    return {
      managers: managers.map(m => ({ id: m.managerId, name: m.name, login: m.login, department: m.department, branch: m.branch })),
      departments: depts.map(d => ({ name: d.name })),
    };
  }));

  // 4. Метрики
  server.registerTool('get_metrics', {
    title: 'Значения метрик',
    description:
      'Главный инструмент: значения метрик каталога за период в разрезе менеджеров, отделов, филиалов, ' +
      'товарных групп или итогом — тем же движком, что отчёт «Продажи → По менеджерам». ' +
      'Можно сравнить с другим периодом (compare_from/compare_to) — вернутся оба значения. ' +
      'Фильтры: managers (имена), departments (названия), branch (Москва/СПб/Краснодар), product_group (любое слово, ' +
      'в т.ч. сленг: «газик»). Планы здесь НЕ считаются — для плана/факта используй get_plan_fact или get_decomposition.',
    inputSchema: {
      metric_ids: z.array(z.string()).min(1).max(15).describe('id метрик из list_metrics'),
      from: DATE, to: DATE,
      group_by: z.enum(['manager', 'department', 'branch', 'product_group', 'total']).default('total'),
      compare_from: DATE.optional(), compare_to: DATE.optional(),
      managers: z.array(z.string()).max(20).optional(),
      departments: z.array(z.string()).max(20).optional(),
      branch: z.string().optional(),
      product_group: z.string().optional(),
      client_type: z.enum(['all', 'b2c', 'b2b']).default('all').describe('b2c — физлица, b2b — юрлица'),
      sort_by: z.string().optional().describe('id метрики для сортировки по убыванию; по умолчанию первая'),
      limit: z.number().int().min(1).max(300).default(40),
    },
    annotations: READ_ONLY,
  }, async (a) => run(session, 'get_metrics', a, async () => {
    const all = await loadMetrics();
    const metrics = resolveMetricIds(a.metric_ids, all);
    const unknown = a.metric_ids.filter(id => !metrics.some(m => m.id === id));
    if (!metrics.length) throw new ToolInputError(`Метрики не найдены: ${unknown.join(', ')}. Возьми id из list_metrics.`);
    const withDeps = withDependencies(metrics, all);
    const filters = await resolveFilters(session, a);
    const common = { session, metrics, withDeps, groupBy: a.group_by as GroupBy, filters, clientType: a.client_type };

    const [cur, prev] = await Promise.all([
      computeMetricRows({ ...common, from: a.from, to: a.to }),
      a.compare_from && a.compare_to ? computeMetricRows({ ...common, from: a.compare_from, to: a.compare_to }) : Promise.resolve(null),
    ]);
    const prevByKey = prev ? new Map(prev.map(r => [r.key, r.values])) : null;
    const sortId = metrics.some(m => m.id === a.sort_by) ? a.sort_by! : metrics[0].id;
    const sorted = [...cur].sort((x, y) => (y.values[sortId] ?? -Infinity) - (x.values[sortId] ?? -Infinity));
    const emptyMetrics = metrics.filter(m => cur.every(r => r.values[m.id] === null)).map(m => m.id);

    const screen = a.group_by === 'product_group' ? '/sales/by-product-groups' : '/sales/by-managers';
    return {
      period: { from: a.from, to: a.to },
      compare: prev ? { from: a.compare_from, to: a.compare_to } : undefined,
      filters: filters.applied,
      metrics: metrics.map(metricMeta),
      rows: sorted.slice(0, a.limit).map(r => ({
        name: r.label,
        ...(r.extra ?? {}),
        values: r.values,
        ...(prevByKey ? { compare: prevByKey.get(r.key) ?? null } : {}),
      })),
      rows_total: sorted.length,
      truncated: sorted.length > a.limit || undefined,
      unknown_metric_ids: unknown.length ? unknown : undefined,
      empty_metrics: emptyMetrics.length
        ? { ids: emptyMetrics, note: 'Нет значений: либо нет данных за период, либо метрика в этом разрезе не считается (планы — get_plan_fact).' }
        : undefined,
      check_in_monolitika: url(screen),
    };
  }));

  // 5. План-факт
  server.registerTool('get_plan_fact', {
    title: 'План / факт',
    description:
      'Выполнение плана продаж на дату: блок «% плана» за день, неделю и месяц + ключевые показатели ' +
      '(первичные/повторные продажи, сделки, брони) — ровно отчёт «МОСКВА» / «Мой отчёт» бота «Аналитик». ' +
      'Разбивка: руководству — по филиалам, руководителю — по своим отделам, менеджеру — личный. ' +
      'С этого начинай вопрос «почему не выполнили план», дальше копай get_metrics с compare_*.',
    inputSchema: {
      date: DATE.optional().describe('Дата среза; по умолчанию сегодня (МСК)'),
      period: z.enum(['day', 'week', 'month']).default('month').describe('Окно для показателей вне блока «% плана»'),
      breakdown: z.enum(['auto', 'branches', 'departments', 'self']).default('auto'),
      departments: z.array(z.string()).max(12).optional().describe('Названия отделов (для breakdown=departments)'),
    },
    annotations: READ_ONLY,
  }, async (a) => run(session, 'get_plan_fact', a, async () => {
    const avail = await availableEntities(session);
    let entities: EntityInput[] = [];
    const mode = a.breakdown === 'auto'
      ? (avail.branches.length ? 'branches' : avail.departments.length ? 'departments' : 'self')
      : a.breakdown;
    if (mode === 'branches') entities = avail.branches.map(b => ({ kind: 'branch', id: b.id }));
    if (mode === 'departments') {
      let depts = avail.departments;
      if (a.departments?.length) {
        const qs = a.departments.map(d => d.toLowerCase());
        depts = depts.filter(d => qs.some(q => d.name.toLowerCase().includes(q)));
      }
      entities = depts.slice(0, 12).map(d => ({ kind: 'department', id: d.id }));
    }
    if (mode === 'self') entities = [{ kind: 'self' }];
    if (!entities.length) throw new ToolInputError('Нет доступных сущностей для такой разбивки (нет филиалов/отделов в вашей зоне).');

    const { spec } = await buildMyReportSpec(session, {
      period: a.period, date: a.date, entities, metricIds: LEAD_METRICS,
    });
    // Текст отчёта бота: BB-коды Битрикса ([b], [i], [color=…]) модели не нужны.
    const text = buildReportText(spec).replace(/\[\/?[a-z]+(=[^\]]*)?\]/gi, '');
    return `${text}\n\nПроверить: ${url('/profile/report')} · планы: ${url('/plans')}`;
  }));

  // 6. Декомпозиция года
  server.registerTool('get_decomposition', {
    title: 'Декомпозиция годового плана',
    description:
      'Годовой план компании против факта по филиалам и категориям (ОС, НЦ, ЖБИ, Металл…): план на сегодня, ' +
      'факт с начала года, текущий месяц. Отвечает на «какой филиал/направление тянет вниз». Только руководству.',
    inputSchema: {
      year: z.number().int().min(2025).max(2030).optional(),
      as_of: DATE.optional().describe('Срез на прошлую дату'),
    },
    annotations: READ_ONLY,
  }, async (a) => run(session, 'get_decomposition', a, async () => {
    if (!hasFullManagerAccess(session) && !hasPerm(session, 'section.decomposition')) {
      throw new ToolInputError('Декомпозиция доступна только руководству компании.');
    }
    const year = a.year ?? new Date().getFullYear();
    const r = await getDecompositionPlanFact(year, a.as_of);
    const m = r.currentMonth - 1;
    return {
      year: r.year, today: r.today,
      working_days: r.workingDays,
      note: 'plan_to_date — план на сегодня (по рабочим дням); fact_ytd — факт с начала года; month_* — текущий месяц.',
      rows: r.rows.map(x => ({
        name: x.label, level: x.level, branch: x.branch, category: x.category,
        plan_year: round(x.planYear),
        plan_to_date: round(x.planToDate),
        fact_ytd: round(x.factYtd),
        pct_to_date: x.planToDate ? round((x.factYtd / x.planToDate) * 100) : null,
        month_plan: round(x.planMonths?.[m] ?? null),
        month_fact: round(x.factMonths[m] ?? null),
        note: x.note,
      })),
      check_in_monolitika: url('/decomposition'),
    };
  }));

  // 7. Рейтинг
  server.registerTool('get_manager_rating', {
    title: 'Рейтинг менеджеров',
    description:
      'Рейтинг менеджеров за период (0–10, перцентиль по осям шаблона карточки: продажи, конверсии, скорость и т.д.) — ' +
      'как в разделе «Рейтинг». В ответе баллы по каждой оси — видно, в чём человек силён.',
    inputSchema: {
      from: DATE, to: DATE,
      segment: z.enum(['all', 'fl', 'ul']).default('all').describe('fl — физлица, ul — юрлица'),
      departments: z.array(z.string()).max(20).optional(),
      limit: z.number().int().min(1).max(100).default(20),
    },
    annotations: READ_ONLY,
  }, async (a) => run(session, 'get_manager_rating', a, async () => {
    const period = parsePeriod(a.from, a.to);
    const filters = await resolveFilters(session, { departments: a.departments });
    const { byManager, axes, poolSize } = await computeManagerRatings({ period, segment: a.segment });
    const ranked = [...byManager.values()].filter(r => r.rating !== null).sort((x, y) => (y.rating ?? 0) - (x.rating ?? 0));
    const rank = new Map(ranked.map((r, i) => [r.managerId, i + 1]));
    const deptNames = a.departments?.length ? new Set((filters.applied.departments as string[]) ?? []) : null;
    const rows = ranked
      .filter(r => !filters.managerIds || filters.managerIds.has(r.managerId))
      .filter(r => !deptNames || deptNames.has(filters.org.get(r.managerId)?.department ?? ''))
      .slice(0, a.limit)
      .map(r => {
        const o = filters.org.get(r.managerId);
        return {
          name: o?.name ?? r.managerId, department: o?.department, branch: o?.branch,
          rating: round(r.rating), rank_in_company: rank.get(r.managerId),
          axes: Object.fromEntries(r.axes.map(x => [x.label, { score: round(x.score), value: round(x.raw) }])),
        };
      });
    return {
      period: { from: a.from, to: a.to }, pool_size: poolSize,
      axes: axes.map(x => ({ name: x.label, weight: x.weight, lower_is_better: x.invert || undefined })),
      filters: filters.applied, rows,
      check_in_monolitika: url('/rating'),
    };
  }));

  // 8. Загрузка открытыми сделками
  server.registerTool('get_open_deals', {
    title: 'Загрузка менеджеров открытыми сделками',
    description:
      'Сколько у менеджеров сейчас открытых сделок (новые + в работе), на какую сумму и сколько «зависших» ' +
      '(за отсечкой модели — кандидаты на перераспределение). Можно сузить товарной группой (product_group, ' +
      'в т.ч. сленг). Вместе с get_metrics по той же группе отвечает на «кого поставить на сделки по X»: ' +
      'кто лучше продаёт X и у кого есть свободная ёмкость.',
    inputSchema: {
      product_group: z.string().optional(),
      managers: z.array(z.string()).max(20).optional().describe('Имена кандидатов — загрузка только по ним'),
      departments: z.array(z.string()).max(20).optional(),
      branch: z.string().optional(),
      deal_scope: z.enum(['all', 'primary', 'repeat']).default('all'),
      limit: z.number().int().min(1).max(300).default(40),
    },
    annotations: READ_ONLY,
  }, async (a) => run(session, 'get_open_deals', a, async () => {
    const filters = await resolveFilters(session, a);
    const { rows } = await getOffloadDeals({ dealScope: a.deal_scope, departmentIds: filters.departmentIds });
    let groupNames: Set<string> | null = null;
    if (filters.productGroupIds) {
      const pg = filters.applied.product_group as { groups: string[] };
      groupNames = new Set(pg.groups);
    }
    const per = new Map<string, { open: number; inWork: number; amount: number; stuck: number; inGroup: number; inGroupAmount: number }>();
    for (const d of rows) {
      if (filters.managerIds && !filters.managerIds.has(d.managerId)) continue;
      const e = per.get(d.managerId) ?? { open: 0, inWork: 0, amount: 0, stuck: 0, inGroup: 0, inGroupAmount: 0 };
      e.open += 1;
      if (d.stageGroup === 'work') e.inWork += 1;
      e.amount += d.amount;
      if (d.recommended) e.stuck += 1;
      if (groupNames?.has(d.kcGroup)) { e.inGroup += 1; e.inGroupAmount += d.amount; }
      per.set(d.managerId, e);
    }
    const list = [...per].map(([id, e]) => {
      const o = filters.org.get(id);
      return {
        name: o?.name ?? `#${id} (нет в оргструктуре)`, department: o?.department, branch: o?.branch,
        open_deals: e.open, in_work: e.inWork, open_amount: Math.round(e.amount), stuck_over_cutoff: e.stuck,
        ...(groupNames ? { open_in_group: e.inGroup, open_in_group_amount: Math.round(e.inGroupAmount) } : {}),
      };
    }).sort((x, y) => (groupNames ? (y.open_in_group ?? 0) - (x.open_in_group ?? 0) : 0) || y.open_deals - x.open_deals);
    return {
      filters: filters.applied,
      note: 'stuck_over_cutoff — сделки дольше типичного срока своей группы (модель «Разгрузки отделов»), только первичка.',
      managers: list.slice(0, a.limit),
      managers_total: list.length,
      check_in_monolitika: url('/offload'),
    };
  }));
}

/** Инструкции сервера: что это за данные и как отвечать. Уходят в контекст модели при подключении. */
export function serverInstructions(session: SessionUser): string {
  const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Moscow' });
  return [
    `Монолитика — BI продаж строительных материалов (Москва, СПб, Краснодар). Сегодня ${today} (МСК). Пользователь: ${session.displayName}.`,
    'Правила:',
    '1. Цифры бери ТОЛЬКО из инструментов, ничего не досчитывай «в уме», кроме простых разниц и долей — и помечай их как свои.',
    '2. Сленг и товары (газик, нерудка, ЖБИ, повторка) — сначала explain_term; если слово не распознано — переспроси.',
    '3. Метрики — тройками «первичные / повторные / все». Уточняй, о каких речь, если неочевидно. id бери из list_metrics.',
    '4. «Почему не выполнили план»: get_plan_fact → get_decomposition (руководству) → get_metrics с compare_* по филиалам/отделам/менеджерам: трафик (сделки), конверсии, средний чек — что именно просело и у кого.',
    '5. «Кого поставить на X»: get_metrics по product_group=X с group_by=manager (продажи, конверсия, чек за 3–6 мес) + get_open_deals по X (текущая загрузка) + при желании get_manager_rating. Предлагай 2–3 кандидата с цифрами.',
    '6. В конце ответа давай ссылку check_in_monolitika — где проверить цифры.',
    '7. «Париж» в адресе = самовывоз. Данных о звонках/контактах клиентов здесь нет намеренно.',
  ].join('\n');
}
