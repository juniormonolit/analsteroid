// Загрузка задач больших сделок прямо из REST Битрикса (копия sa.bitrix_task_current отстаёт)
// и сборка карточек. Снимок кэшируется: память + Redis, свежий 3 мин, потом stale-while-revalidate.
import { redisReady } from '@/lib/cache/redis';
import { bx } from '@/lib/bitrix/notify';
import { BIG_DEALS_GROUPS, BIG_DEALS_GROUP_IDS, STUCK_DAYS, BIG_COLUMNS, taskUrl, type BigColumnKey } from './config';
import type { BigDealInfo, BigRelatedTask, BigTaskCard } from './types';
import { bxBatch, taskWebhook, type BatchCmd } from './rest';
import { columnOfStage, stagesOfGroup, type BigStage } from './stages';
import {
  callStats, clientOf, dealIdOf, fetchCalls, fetchDealGroups, fetchHeads, fetchDeals, fetchRelated, relatedIndex, loadNames, personOf, productGroupOf, rememberName, taskAmountOf, taskState,
} from './enrich';
import { resolveSince } from './stageSince';

export const TASK_SELECT = [
  'ID', 'TITLE', 'STAGE_ID', 'STATUS', 'SUB_STATUS', 'RESPONSIBLE_ID', 'CREATED_BY', 'AUDITORS', 'CREATED_DATE', 'CHANGED_DATE',
  'CLOSED_DATE', 'DEADLINE', 'UF_CRM_TASK', 'DESCRIPTION', 'GROUP_ID', 'UF_AUTO_593587150308',
];
const CLOSED_DAYS = 30;
const FRESH_MS = 3 * 60_000;
const KEEP_SEC = 24 * 3600;
const REDIS_KEY = 'bigdeals:snapshot:v1';

export interface RawTask {
  id: string; title: string; stageId: string; status: string; subStatus?: string; responsibleId: string; createdBy: string;
  auditors?: string[]; createdDate: string; changedDate?: string | null; closedDate?: string | null; deadline?: string | null;
  ufCrmTask?: string[] | null; description?: string | null; groupId: string; ufAuto593587150308?: string | null;
  creator?: { id: string; name: string }; responsible?: { id: string; name: string };
}

const iso = (s: string | null | undefined) => (s ? new Date(s).toISOString() : null);

/** Постраничная выборка tasks.task.list по набору фильтров: первая волна — первые страницы и total, вторая — остальные. */
async function listTasks(filters: Record<string, Record<string, unknown>>): Promise<RawTask[]> {
  const cmd = (f: Record<string, unknown>, start: number): BatchCmd => ({
    method: 'tasks.task.list', params: { filter: f, select: TASK_SELECT, order: { ID: 'asc' }, start },
  });
  const first: Record<string, BatchCmd> = {};
  for (const [k, f] of Object.entries(filters)) first[k] = cmd(f, 0);
  const r1 = await bxBatch<{ tasks: RawTask[] }>(taskWebhook(), first);
  const all: RawTask[] = Object.values(r1.result).flatMap(p => p?.tasks ?? []);
  const rest: Record<string, BatchCmd> = {};
  for (const [k, f] of Object.entries(filters)) {
    const total = Number(r1.total[k] ?? 0);
    for (let s = 50; s < total; s += 50) rest[`${k}_${s}`] = cmd(f, s);
  }
  if (Object.keys(rest).length) {
    const r2 = await bxBatch<{ tasks: RawTask[] }>(taskWebhook(), rest);
    all.push(...Object.values(r2.result).flatMap(p => p?.tasks ?? []));
  }
  const seen = new Map<string, RawTask>();
  for (const t of all) seen.set(String(t.id), t);
  return [...seen.values()];
}

/** Все задачи проектов: открытые + закрытые за CLOSED_DAYS. */
export async function fetchRawTasks(groupIds: readonly number[] = BIG_DEALS_GROUP_IDS): Promise<RawTask[]> {
  const closedSince = new Date(Date.now() - CLOSED_DAYS * 86400_000).toISOString();
  const filters: Record<string, Record<string, unknown>> = {};
  for (const g of groupIds) {
    filters[`o${g}`] = { GROUP_ID: g, '<REAL_STATUS': 5 };
    filters[`c${g}`] = { GROUP_ID: g, REAL_STATUS: 5, '>=CLOSED_DATE': closedSince };
  }
  return listTasks(filters);
}

/** Закрытые задачи, которых НЕТ в снимке (закрыты раньше CLOSED_DAYS), созданные не раньше createdSince. Для аналитики. */
export async function fetchArchivedRawTasks(createdSinceIso: string, groupIds: readonly number[] = BIG_DEALS_GROUP_IDS): Promise<RawTask[]> {
  const closedBefore = new Date(Date.now() - CLOSED_DAYS * 86400_000).toISOString();
  const filters: Record<string, Record<string, unknown>> = {};
  for (const g of groupIds) {
    filters[`a${g}`] = { GROUP_ID: g, REAL_STATUS: 5, '<CLOSED_DATE': closedBefore, '>=CREATED_DATE': createdSinceIso };
  }
  return listTasks(filters);
}

/** Сырые задачи → карточки (сделки, звонки, связанные, время в колонке). */
export async function buildCards(raw: RawTask[]): Promise<BigTaskCard[]> {
  const groupIds = [...new Set(raw.map(t => Number(t.groupId)))];
  const stagesBy = new Map<number, BigStage[]>();
  await Promise.all(groupIds.map(async g => { stagesBy.set(g, await stagesOfGroup(g).catch(() => [])); }));

  for (const t of raw) { rememberName(t.creator?.id, t.creator?.name); rememberName(t.responsible?.id, t.responsible?.name); }
  const dealIds = raw.map(t => dealIdOf(t.ufCrmTask)).filter((x): x is number => !!x);
  const minCreated = raw.reduce((m, t) => Math.min(m, new Date(t.createdDate).getTime() || m), Date.now());
  const dbg = process.env.BIGDEALS_DEBUG ? (l: string) => (p: Promise<unknown>) => { const t = Date.now(); p.then(() => console.log(`[big-deals] ${l} ${Date.now() - t} мс`), () => {}); } : null;
  const pDeals = fetchDeals(dealIds).catch(e => { console.warn('[big-deals] deals', e instanceof Error ? e.message : e); return new Map<number, BigDealInfo>(); });
  const pCalls = fetchCalls([...new Set(dealIds)], new Date(minCreated).toISOString());
  const pGroups = fetchDealGroups([...new Set(dealIds)]);
  // Одна карточка (refreshTask) — прямой запрос по сделке; вся доска — фоновый индекс.
  const pRel = (raw.length <= 5 ? fetchRelated(dealIds.map(id => `D_${id}`)) : Promise.resolve(relatedIndex())).catch(e => { console.warn('[big-deals] related', e instanceof Error ? e.message : e); return new Map<string, BigRelatedTask[]>(); });
  if (dbg) { dbg('deals')(pDeals); dbg('calls')(pCalls); dbg('related')(pRel); }
  const [deals, calls, related, dealGroups, heads] = await Promise.all([pDeals, pCalls, pRel, pGroups, fetchHeads()]);
  await loadNames(raw.flatMap(t => [t.responsibleId, t.createdBy]).map(String));

  const pre: { t: RawTask; column: BigColumnKey; stageId: number; stageTitle: string }[] = [];
  for (const t of raw) {
    const c = columnOfStage(stagesBy.get(Number(t.groupId)) ?? [], t.stageId);
    if (!c.column) continue; // мусорная стадия («Название»)
    pre.push({ t, column: c.column, stageId: c.stageId, stageTitle: c.title });
  }
  const since = await resolveSince(pre.map(p => ({ id: Number(p.t.id), column: p.column, firstSeen: iso(p.t.changedDate) ?? iso(p.t.createdDate)! })));
  const now = Date.now();
  const short = new Map<number, string>(BIG_DEALS_GROUPS.map(g => [g.id, g.short]));

  return pre.map(({ t, column, stageId, stageTitle }) => {
    const id = Number(t.id);
    const dealId = dealIdOf(t.ufCrmTask);
    const createdAt = iso(t.createdDate)!;
    const inColumnSince = since.get(id) ?? iso(t.changedDate) ?? createdAt;
    const card: BigTaskCard = {
      id, title: t.title, groupId: Number(t.groupId), groupShort: short.get(Number(t.groupId)) ?? String(t.groupId),
      stageId, stageTitle, column, state: taskState(t.status, t.subStatus),
      responsible: personOf(t.responsibleId) ?? { id: String(t.responsibleId), name: `#${t.responsibleId}` },
      creator: personOf(t.createdBy) ?? { id: String(t.createdBy), name: `#${t.createdBy}` },
      auditors: (t.auditors ?? []).map(String),
      createdAt, changedAt: iso(t.changedDate), closedAt: iso(t.closedDate), deadlineAt: iso(t.deadline),
      inColumnSince, daysInColumn: 0, stuck: false,
      // Менеджер не назначен: исполнитель — РОП/директор отдела. Оргструктура недоступна — не знаем (false).
      unassigned: !!heads?.has(String(t.responsibleId)),
      // Товарная группа — из сделки в БД (владелец 18.11: название задачи — свободный текст, фильтр шумел).
      // Без БД (локально) — часть названия задачи до «|».
      ...(() => {
        const g = dealId ? dealGroups?.get(dealId) : undefined;
        if (dealGroups && g) return { productGroup: g.head, productGroups: g.all };
        if (dealGroups) return { productGroup: null, productGroups: [] };
        const t1 = productGroupOf(t.title);
        return { productGroup: t1, productGroups: t1 ? [t1] : [] };
      })(),
      taskAmount: taskAmountOf(t.description, t.ufAuto593587150308),
      client: clientOf(t.description),
      deal: dealId ? deals.get(dealId) ?? null : null,
      calls: calls && dealId ? callStats(calls.get(dealId), new Date(createdAt).getTime()) : calls ? callStats([], 0) : null,
      related: dealId ? related.get(`D_${dealId}`) ?? [] : [],
      url: taskUrl(id),
    };
    return withAge(card, now);
  });
}

const FINAL = new Set(BIG_COLUMNS.filter(c => c.final).map(c => c.key));
/** Пересчитать «дней в колонке» / stuck на момент `now` (снимок может быть старым). */
export function withAge(card: BigTaskCard, now = Date.now()): BigTaskCard {
  const days = Math.max(0, Math.floor((now - new Date(card.inColumnSince).getTime()) / 86400_000));
  const lim = STUCK_DAYS[card.column];
  return { ...card, daysInColumn: days, stuck: !FINAL.has(card.column) && card.state !== 'done' && lim !== undefined && days > lim };
}

// ── снимок с кэшем ──────────────────────────────────────────────────────────
export interface BigSnapshot { at: number; cards: BigTaskCard[] }
let mem: BigSnapshot | null = null;
let inflight: Promise<BigSnapshot> | null = null;

async function rebuild(): Promise<BigSnapshot> {
  if (inflight) return inflight;
  inflight = (async () => {
    const t0 = Date.now();
    const cards = await buildCards(await fetchRawTasks());
    const snap = { at: Date.now(), cards };
    mem = snap;
    console.log(`[big-deals] снимок: ${cards.length} задач за ${Date.now() - t0} мс`);
    const redis = await redisReady().catch(() => null);
    if (redis) await redis.set(REDIS_KEY, JSON.stringify(snap), 'EX', KEEP_SEC).catch(() => {});
    return snap;
  })().finally(() => { inflight = null; });
  return inflight;
}

async function saveSnapshot(snap: BigSnapshot): Promise<void> {
  mem = snap;
  const redis = await redisReady().catch(() => null);
  if (redis) await redis.set(REDIS_KEY, JSON.stringify(snap), 'EX', KEEP_SEC).catch(() => {});
}

/** Снимок доски. Старше 3 мин — отдаём как есть (stale: true) и обновляем в фоне. force — ждать пересборки. */
export async function loadSnapshot(opts: { force?: boolean } = {}): Promise<BigSnapshot & { stale: boolean }> {
  if (opts.force) return { ...(await rebuild()), stale: false };
  if (!mem) {
    const redis = await redisReady().catch(() => null);
    if (redis) {
      try { const hit = await redis.get(REDIS_KEY); if (hit) mem = JSON.parse(hit) as BigSnapshot; } catch { /* нет кэша */ }
    }
  }
  if (!mem) return { ...(await rebuild()), stale: false };
  const stale = Date.now() - mem.at > FRESH_MS;
  if (stale) void rebuild().catch(e => console.warn('[big-deals] фоновая пересборка', e instanceof Error ? e.message : e));
  return { ...mem, stale };
}

/** Пометить снимок устаревшим — следующий запрос доски запустит фоновую пересборку. */
export function invalidateTask(_taskId?: number): void {
  if (mem) mem = { ...mem, at: 0 };
}

/** Перечитать одну задачу из Битрикса и заменить её карточку в снимке. null — задачи нет / не из проектов. */
export async function refreshTask(taskId: number): Promise<BigTaskCard | null> {
  const body = await bx(taskWebhook(), 'tasks.task.get', { taskId, select: TASK_SELECT }) as { result: { task?: RawTask } };
  const t = body.result?.task;
  const snap: BigSnapshot = mem ?? await loadSnapshot();
  const others = snap.cards.filter(c => c.id !== taskId);
  if (!t || !BIG_DEALS_GROUP_IDS.includes(Number(t.groupId))) {
    await saveSnapshot({ at: snap.at, cards: others });
    return null;
  }
  const [card] = await buildCards([t]);
  await saveSnapshot({ at: snap.at, cards: card ? [...others, card] : others });
  return card ?? null;
}

/** Карточка задачи из снимка (без похода в Битрикс; снимок — память или Redis, пересборку НЕ запускает).
 *  null — снимка нет или задачи в нём нет (не из проектов / закрыта давно). Для проверки видимости в действиях. */
export async function cardFromSnapshot(taskId: number): Promise<BigTaskCard | null> {
  if (!mem) {
    const redis = await redisReady().catch(() => null);
    if (redis) {
      try { const hit = await redis.get(REDIS_KEY); if (hit) mem = JSON.parse(hit) as BigSnapshot; } catch { /* нет кэша */ }
    }
  }
  const c = mem?.cards.find(x => x.id === taskId);
  return c ? withAge(c) : null;
}

// ── архив закрытых для аналитики (лениво, отдельно от снимка доски) ───────────
const ARCHIVE_TTL = 30 * 60_000;
const archive = new Map<string, { at: number; cards: Promise<BigTaskCard[]> }>();

/** Закрытые раньше CLOSED_DAYS задачи, созданные с даты `fromDate` (YYYY-MM-DD). Кэш 30 мин в памяти. */
export function loadArchivedCards(fromDate: string): Promise<BigTaskCard[]> {
  const hit = archive.get(fromDate);
  if (hit && Date.now() - hit.at < ARCHIVE_TTL) return hit.cards;
  const t0 = Date.now();
  const cards = (async () => {
    const raw = await fetchArchivedRawTasks(new Date(`${fromDate}T00:00:00+03:00`).toISOString());
    const out = await buildCards(raw);
    console.log(`[big-deals] архив с ${fromDate}: ${out.length} задач за ${Date.now() - t0} мс`);
    return out;
  })();
  cards.catch(() => archive.delete(fromDate));
  for (const [k, v] of archive) if (Date.now() - v.at >= ARCHIVE_TTL) archive.delete(k);
  archive.set(fromDate, { at: Date.now(), cards });
  return cards;
}
