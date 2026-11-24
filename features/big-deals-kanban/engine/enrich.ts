// Обогащение задач больших сделок: сделки CRM, имена людей, звонки (va.calls), связанные задачи.
import { analyticsDb } from '@/lib/db/clients';
import { BIG_DEALS_GROUP_IDS, dealUrl, taskUrl } from './config';
import type { BigCallStats, BigDealInfo, BigPerson, BigRelatedTask, BigTaskState } from './types';
import { bxBatch, crmReadWebhook, taskWebhook, type BatchCmd } from './rest';
import { bx } from '@/lib/bitrix/notify';

// ── люди ────────────────────────────────────────────────────────────────────
const names = new Map<string, string>();
export function rememberName(id: string | number | null | undefined, name: string | null | undefined): void {
  if (id && name && String(name).trim()) names.set(String(id), String(name).trim());
}
export function personOf(id: string | number | null | undefined): BigPerson | null {
  if (!id || String(id) === '0') return null;
  const k = String(id);
  return { id: k, name: names.get(k) ?? `#${k}` };
}
/** Догружает имена неизвестных id (user.get, batch). Ошибки глотаются — останется «#id». */
export async function loadNames(ids: Iterable<string>): Promise<void> {
  const need = [...new Set([...ids].filter(id => id && id !== '0' && !names.has(id)))];
  if (!need.length) return;
  const cmds: Record<string, BatchCmd> = {};
  for (let i = 0; i < need.length; i += 50) cmds[`u${i}`] = { method: 'user.get', params: { FILTER: { ID: need.slice(i, i + 50) } } };
  try {
    const r = await bxBatch<{ ID: string; NAME?: string; LAST_NAME?: string }[]>(taskWebhook(), cmds);
    for (const list of Object.values(r.result)) for (const u of list ?? []) rememberName(u.ID, [u.NAME, u.LAST_NAME].filter(Boolean).join(' '));
  } catch (e) { console.warn('[big-deals] user.get', e instanceof Error ? e.message : e); }
}

// ── статус задачи ───────────────────────────────────────────────────────────
export function taskState(status: string | number, subStatus?: string | number | null): BigTaskState {
  const s = Number(status), sub = Number(subStatus);
  if (s === 5) return 'done';
  if (s === 4) return 'control';
  if (s === 6) return 'deferred';
  if (sub === -2 || s === 1) return 'unread';
  if (s === 3) return 'in_progress';
  return 'pending';
}

// ── сделки ──────────────────────────────────────────────────────────────────
let stageNames: { at: number; map: Map<string, { name: string; color: string | null }> } | null = null;
export async function dealStageNames(): Promise<Map<string, { name: string; color: string | null }>> {
  if (stageNames && Date.now() - stageNames.at < 3600_000) return stageNames.map;
  const body = await bx(crmReadWebhook(), 'crm.status.list', {}) as { result: { ENTITY_ID: string; STATUS_ID: string; NAME: string; EXTRA?: { COLOR?: string } }[] };
  const map = new Map<string, { name: string; color: string | null }>();
  for (const s of body.result ?? []) if (s.ENTITY_ID?.startsWith('DEAL_STAGE')) {
    const c = s.EXTRA?.COLOR;
    map.set(s.STATUS_ID, { name: s.NAME, color: c && /^#[0-9a-f]{3,8}$/i.test(c) ? c : null });
  }
  stageNames = { at: Date.now(), map };
  return map;
}

interface BxDealRow {
  ID: string; TITLE?: string; OPPORTUNITY?: string; STAGE_ID?: string; CATEGORY_ID?: string; ASSIGNED_BY_ID?: string;
  CONTACT_ID?: string | null; COMPANY_ID?: string | null; CLOSED?: string; STAGE_SEMANTIC_ID?: string; DATE_CREATE?: string; MOVED_TIME?: string;
}

export async function fetchDeals(ids: number[]): Promise<Map<number, BigDealInfo>> {
  const out = new Map<number, BigDealInfo>();
  const uniq = [...new Set(ids.filter(x => x > 0))];
  if (!uniq.length) return out;
  const cmds: Record<string, BatchCmd> = {};
  for (let i = 0; i < uniq.length; i += 50) {
    cmds[`d${i}`] = { method: 'crm.deal.list', params: {
      filter: { '@ID': uniq.slice(i, i + 50) },
      select: ['ID', 'TITLE', 'OPPORTUNITY', 'STAGE_ID', 'CATEGORY_ID', 'ASSIGNED_BY_ID', 'CONTACT_ID', 'COMPANY_ID', 'CLOSED', 'STAGE_SEMANTIC_ID', 'DATE_CREATE', 'MOVED_TIME'],
    } };
  }
  const [r, stNames] = await Promise.all([bxBatch<BxDealRow[]>(crmReadWebhook(), cmds), dealStageNames().catch(() => new Map<string, { name: string; color: string | null }>())]);
  const assignees = new Set<string>();
  const rows: BxDealRow[] = Object.values(r.result).flat().filter(Boolean);
  for (const d of rows) if (d.ASSIGNED_BY_ID) assignees.add(String(d.ASSIGNED_BY_ID));
  await loadNames(assignees);
  for (const d of rows) {
    const id = Number(d.ID);
    const sem = d.STAGE_SEMANTIC_ID;
    out.set(id, {
      id, title: d.TITLE ?? '', amount: Number(d.OPPORTUNITY) || 0,
      stageId: d.STAGE_ID ?? '', stageName: stNames.get(d.STAGE_ID ?? '')?.name ?? d.STAGE_ID ?? '',
      stageColor: stNames.get(d.STAGE_ID ?? '')?.color ?? null,
      categoryId: d.CATEGORY_ID != null && d.CATEGORY_ID !== '' ? Number(d.CATEGORY_ID) : null,
      createdAt: d.DATE_CREATE ? new Date(d.DATE_CREATE).toISOString() : null,
      stageAt: d.MOVED_TIME ? new Date(d.MOVED_TIME).toISOString() : null,
      closed: sem === 'S' ? 'won' : sem === 'F' ? 'lost' : null,
      assigned: personOf(d.ASSIGNED_BY_ID),
      contactId: Number(d.CONTACT_ID) || null, companyId: Number(d.COMPANY_ID) || null,
      url: dealUrl(id),
    });
  }
  return out;
}

// ── товарные группы сделок (sa.deals: head-группа + группы товаров, как фильтр повторки shippedGroups.ts) ──
export interface DealGroups { head: string | null; all: string[] }
/** deal_id → товарные группы. null — БД недоступна (локально так всегда). */
export async function fetchDealGroups(dealIds: number[]): Promise<Map<number, DealGroups> | null> {
  const out = new Map<number, DealGroups>();
  if (!dealIds.length) return out;
  try {
    const q = analyticsDb().query<{ deal_id: string; head: string | null; groups: string[] | null }>(
      `SELECT d.deal_id::text AS deal_id, d.head_group_name AS head,
              (SELECT array_agg(DISTINCT g) FROM (
                 SELECT d.head_group_name AS g
                 UNION SELECT p->>'head_group_name' FROM jsonb_array_elements(coalesce(d.products, '[]'::jsonb)) p
                  WHERE coalesce(p->>'type', '') <> 'услуга') x
                WHERE g IS NOT NULL AND g !~* '^(доставка|перевозка|услуг|разное)') AS groups
         FROM sa.deals d WHERE d.deal_id = ANY($1::bigint[])`,
      [dealIds],
    );
    q.catch(() => {});
    const res = await Promise.race([q, new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timeout 8s')), 8000))]);
    for (const r of res.rows) {
      const head = r.head && !/^(доставка|перевозка|услуг|разное)/i.test(r.head) ? r.head : null;
      const all = (r.groups ?? []).filter(Boolean).sort((a, b) => a.localeCompare(b, 'ru'));
      out.set(Number(r.deal_id), { head: head ?? all[0] ?? null, all });
    }
    return out;
  } catch (e) {
    console.warn('[big-deals] sa.deals (товарные группы) недоступна:', e instanceof Error ? e.message : e);
    return null;
  }
}

// ── «Нераспределённые»: рядовые менеджеры по оргструктуре ───────────────────────────
// Менеджер, который сам себе поставил задачу (Девришев, Пыжьянова), — не «без менеджера». Рядовой = в
// sa.org_resolved_hierarchy у него есть РОП и это не он сам. Кэш 10 мин; null — БД недоступна (локально).
let plainMemo: { at: number; ids: Set<string> } | null = null;
export async function fetchPlainManagers(): Promise<Set<string> | null> {
  if (plainMemo && Date.now() - plainMemo.at < 10 * 60_000) return plainMemo.ids;
  try {
    const q = analyticsDb().query<{ id: string }>(
      `SELECT DISTINCT manager_bitrix_user_id::text AS id FROM sa.org_resolved_hierarchy
        WHERE is_active AND rop_bitrix_user_id IS NOT NULL AND rop_bitrix_user_id <> manager_bitrix_user_id`);
    q.catch(() => {});
    const res = await Promise.race([q, new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timeout 8s')), 8000))]);
    plainMemo = { at: Date.now(), ids: new Set(res.rows.map(r => String(r.id))) };
    return plainMemo.ids;
  } catch (e) {
    console.warn('[big-deals] оргструктура (рядовые менеджеры) недоступна:', e instanceof Error ? e.message : e);
    return plainMemo?.ids ?? null;
  }
}

// ── звонки (va.calls, ТОЛЬКО failed_at_stage IS NULL) ──────────────────────
export interface CallRow { at: number; sec: number }
/** deal_id → звонки с `sinceIso`. null — БД недоступна (локально так всегда). */
export async function fetchCalls(dealIds: number[], sinceIso: string): Promise<Map<number, CallRow[]> | null> {
  const out = new Map<number, CallRow[]>();
  if (!dealIds.length) return out;
  try {
    const q = analyticsDb().query<{ deal_id: string; called_at: Date; duration_seconds: number | null }>(
      `SELECT c.deal_id::text AS deal_id, c.called_at, c.duration_seconds FROM va.calls c
        WHERE c.deal_id = ANY($1::bigint[]) AND c.called_at >= $2::timestamptz AND c.failed_at_stage IS NULL`,
      [dealIds, sinceIso],
    );
    // БД недоступна/тормозит — доска не ждёт: без звонков через 8 с.
    q.catch(() => {});
    const res = await Promise.race([q, new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timeout 8s')), 8000))]);
    for (const r of res.rows) {
      const k = Number(r.deal_id);
      const list = out.get(k) ?? [];
      list.push({ at: new Date(r.called_at).getTime(), sec: Number(r.duration_seconds ?? 0) });
      out.set(k, list);
    }
    return out;
  } catch (e) {
    console.warn('[big-deals] va.calls недоступна:', e instanceof Error ? e.message : e);
    return null;
  }
}
export function callStats(rows: CallRow[] | undefined, sinceMs: number): BigCallStats {
  let total = 0, talks = 0, talkSeconds = 0, last = 0;
  for (const c of rows ?? []) {
    if (c.at < sinceMs) continue;
    total++;
    if (c.sec > 20) { talks++; talkSeconds += c.sec; }
    if (c.at > last) last = c.at;
  }
  return { total, talks, talkSeconds, lastAt: last ? new Date(last).toISOString() : null };
}

// ── связанные задачи (та же сделка, вне проектов больших сделок, 60 дней) ──
interface BxRelRow {
  id: string; title: string; status: string; subStatus?: string; groupId?: string; group?: { name?: string } | unknown[];
  responsibleId?: string; responsible?: { id: string; name: string }; changedDate?: string | null; closedDate?: string | null;
  ufCrmTask?: string[] | null;
}
const REL_SELECT = ['ID', 'TITLE', 'STATUS', 'SUB_STATUS', 'GROUP_ID', 'RESPONSIBLE_ID', 'CHANGED_DATE', 'CLOSED_DATE', 'UF_CRM_TASK'];
function addRelated(out: Map<string, BigRelatedTask[]>, t: BxRelRow, want: Set<string> | null): void {
  if (BIG_DEALS_GROUP_IDS.includes(Number(t.groupId))) return;
  if (t.responsible) rememberName(t.responsible.id, t.responsible.name);
  const rel: BigRelatedTask = {
    id: Number(t.id), title: t.title,
    groupName: t.group && !Array.isArray(t.group) ? t.group.name ?? null : null,
    state: taskState(t.status, t.subStatus),
    responsible: personOf(t.responsibleId),
    changedAt: t.changedDate ? new Date(t.changedDate).toISOString() : null,
    url: taskUrl(Number(t.id)),
  };
  for (const k of t.ufCrmTask ?? []) if (/^D_\d+$/.test(k) && (!want || want.has(k))) {
    const list = out.get(k) ?? [];
    if (!list.some(x => x.id === rel.id)) list.push(rel);
    out.set(k, list);
  }
}

/** Связанные задачи нескольких сделок — по сделке на команду (фильтр UF_CRM_TASK массивом Битрикс
 *  выполняет ~48 с, одиночный — ~1 с). Для точечного обновления карточки, не для всей доски. */
export async function fetchRelated(dealKeys: string[]): Promise<Map<string, BigRelatedTask[]>> {
  const out = new Map<string, BigRelatedTask[]>();
  const uniq = [...new Set(dealKeys)].slice(0, 50);
  if (!uniq.length) return out;
  const since = new Date(Date.now() - RELATED_DAYS * 86400_000).toISOString();
  const cmds: Record<string, BatchCmd> = {};
  uniq.forEach((k, i) => { cmds[`r${i}`] = { method: 'tasks.task.list', params: { filter: { UF_CRM_TASK: k, '>=CHANGED_DATE': since }, select: REL_SELECT } }; });
  const r = await bxBatch<{ tasks: BxRelRow[] }>(taskWebhook(), cmds);
  const want = new Set(uniq);
  for (const page of Object.values(r.result)) for (const t of page?.tasks ?? []) addRelated(out, t, want);
  return out;
}

// Индекс связанных задач для всей доски: все задачи портала вне проектов больших сделок,
// изменённые за RELATED_INDEX_DAYS (~3–4 тыс., страница ~2,6 с у Битрикса ⇒ 1–2 мин). Строится в фоне
// раз в 10 мин; доска его не ждёт (до первой сборки related = []).
const RELATED_DAYS = 60;
const RELATED_INDEX_DAYS = 14;
const REL_TTL_MS = 10 * 60_000;
let relIndex: { at: number; map: Map<string, BigRelatedTask[]> } | null = null;
let relBuilding: Promise<void> | null = null;

async function buildRelatedIndex(): Promise<void> {
  const t0 = Date.now();
  const since = new Date(Date.now() - RELATED_INDEX_DAYS * 86400_000).toISOString();
  const filter = { '>=CHANGED_DATE': since, '!GROUP_ID': BIG_DEALS_GROUP_IDS, '!UF_CRM_TASK': false };
  const cmd = (start: number): BatchCmd => ({ method: 'tasks.task.list', params: { filter, select: REL_SELECT, order: { ID: 'desc' }, start } });
  const first = await bxBatch<{ tasks: BxRelRow[] }>(taskWebhook(), { p0: cmd(0) });
  const total = Number(first.total.p0 ?? 0);
  const rest: Record<string, BatchCmd> = {};
  for (let s = 50; s < total; s += 50) rest[`p${s}`] = cmd(s);
  const r = Object.keys(rest).length ? await bxBatch<{ tasks: BxRelRow[] }>(taskWebhook(), rest, 8) : { result: {} as Record<string, { tasks: BxRelRow[] }> };
  const map = new Map<string, BigRelatedTask[]>();
  for (const page of [...Object.values(first.result), ...Object.values(r.result)]) for (const t of page?.tasks ?? []) addRelated(map, t, null);
  relIndex = { at: Date.now(), map };
  console.log(`[big-deals] связанные задачи: ${total} задач, ${map.size} сделок за ${Date.now() - t0} мс`);
}

/** Текущий индекс (может быть пустым) + фоновое обновление, если старше 10 мин. */
export function relatedIndex(): Map<string, BigRelatedTask[]> {
  if ((!relIndex || Date.now() - relIndex.at > REL_TTL_MS) && !relBuilding) {
    relBuilding = buildRelatedIndex()
      .catch(e => console.warn('[big-deals] индекс связанных', e instanceof Error ? e.message : e))
      .finally(() => { relBuilding = null; });
  }
  return relIndex?.map ?? new Map();
}
/** Для скриптов/прогрева: дождаться сборки индекса. */
export async function relatedIndexReady(): Promise<Map<string, BigRelatedTask[]>> {
  relatedIndex();
  if (relBuilding) await relBuilding;
  return relIndex?.map ?? new Map();
}

// ── разбор текста задачи ────────────────────────────────────────────────────
export function productGroupOf(title: string): string | null {
  const i = title.indexOf('|');
  const g = (i >= 0 ? title.slice(0, i) : '').trim();
  return g || null;
}
export function taskAmountOf(description: string | null | undefined, ufAmount?: string | null): number | null {
  const m = /Общая сумма:\s*([\d\s ]+(?:[.,]\d+)?)/i.exec(description ?? '') ?? /([\d\s ]+(?:[.,]\d+)?)/.exec(ufAmount ?? '');
  if (!m) return null;
  const n = Number(m[1].replace(/[\s ]/g, '').replace(',', '.'));
  return Number.isFinite(n) && n > 0 ? n : null;
}
export function dealIdOf(uf: string[] | null | undefined): number | null {
  for (const k of uf ?? []) { const m = /^D_(\d+)$/.exec(k); if (m) return Number(m[1]); }
  return null;
}

/** «[b]Клиент: [/b]Максим Иванов» (или без BB-кодов) → «Максим Иванов» — для поиска по доске. */
export function clientOf(description: string | null | undefined): string | null {
  const m = /Клиент\s*:\s*(?:\[\/b\])?\s*([^\n\r[]{1,200})/i.exec(description ?? '');
  const v = m?.[1].replace(/\s+/g, ' ').trim();
  return v ? v.slice(0, 120) : null;
}
