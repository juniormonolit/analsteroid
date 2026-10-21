// «Канбан повторных продаж» — настройки доски и шаблоны сообщений к задаче (владелец 21.10).
// Таблицы — миграция 233 (БД system): repeat_kanban_settings, repeat_kanban_templates.
//
// Настройки — ключ → jsonb. Пока одна: норма активных задач на менеджера
// (активные = незакрытые и не сданные на проверку задачи проекта «Повторные продажи»).
// Читает доска на каждый запрос — поэтому кэш в памяти 60 с, а при ошибке БД (миграция
// не накачена, база легла) отдаём дефолты, доска не должна падать из-за настроек.
//
// Шаблоны — текст с плейсхолдерами {{ключ}} (templatePlaceholders.ts). renderTemplate
// подставляет данные заказчика; каждый кусок данных считается лениво — только если
// плейсхолдер есть в тексте (рекомендации — это полная сборка карточки клиента, секунды).
import { analyticsDb, systemDb } from '@/lib/db/clients';
import { getCachedClientNames, resolveClientNames } from '@/lib/bitrix/clientNames';
import { CLIENT_KEY_CASE_SQL } from '@/features/customers/engine/clientKey';
import { fetchCrossSellMatrix, fetchCrossSellPriorities, recommendFor } from '@/features/customers/engine/crossSell';
import { REPEAT_SPLIT_GAP_DAYS } from '@/lib/metrics/repeatRule';
import { WINDOW_DAYS } from './config';
import { PLACEHOLDER_RE, placeholderKey } from './templatePlaceholders';

export class SettingsError extends Error {}

// ── Настройки ──────────────────────────────────────────────────────────────

export interface KanbanSettings { managerTaskLimit: number }

export const DEFAULT_SETTINGS: KanbanSettings = { managerTaskLimit: 10 };
export const TASK_LIMIT_MIN = 1;
export const TASK_LIMIT_MAX = 200;

const SETTINGS_TTL_MS = 60_000;
let settingsCache: { at: number; value: KanbanSettings } | null = null;

function parseTaskLimit(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN;
  return Number.isInteger(n) && n >= TASK_LIMIT_MIN && n <= TASK_LIMIT_MAX ? n : null;
}

/** Настройки доски с дефолтами. Кэш в памяти 60 с; ошибка БД — дефолты (и не кэшируем). */
export async function fetchKanbanSettings(): Promise<KanbanSettings> {
  if (settingsCache && Date.now() - settingsCache.at < SETTINGS_TTL_MS) return settingsCache.value;
  try {
    const r = await systemDb().query<{ key: string; value: unknown }>(`SELECT key, value FROM repeat_kanban_settings`);
    const map = new Map(r.rows.map(x => [x.key, x.value]));
    const value: KanbanSettings = {
      managerTaskLimit: parseTaskLimit(map.get('manager_task_limit')) ?? DEFAULT_SETTINGS.managerTaskLimit,
    };
    settingsCache = { at: Date.now(), value };
    return value;
  } catch (e) {
    console.warn('[repeat-kanban settings] настройки недоступны, беру дефолты:', e instanceof Error ? e.message : e);
    return { ...DEFAULT_SETTINGS };
  }
}

/** Сохранить настройки (частично). Неверное значение — SettingsError с текстом для UI. */
export async function saveKanbanSettings(patch: Partial<Record<keyof KanbanSettings, unknown>>, by: string): Promise<KanbanSettings> {
  const rows: [string, unknown][] = [];
  if (patch.managerTaskLimit !== undefined) {
    const n = parseTaskLimit(patch.managerTaskLimit);
    if (n === null) throw new SettingsError(`Норма задач — целое число от ${TASK_LIMIT_MIN} до ${TASK_LIMIT_MAX}`);
    rows.push(['manager_task_limit', n]);
  }
  if (!rows.length) throw new SettingsError('Нечего сохранять');
  const db = systemDb();
  for (const [key, value] of rows) {
    await db.query(
      `INSERT INTO repeat_kanban_settings (key, value, updated_at, updated_by) VALUES ($1, $2::jsonb, now(), $3)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now(), updated_by = EXCLUDED.updated_by`,
      [key, JSON.stringify(value), by],
    );
  }
  settingsCache = null;
  return fetchKanbanSettings();
}

// ── Шаблоны ────────────────────────────────────────────────────────────────

export interface MessageTemplate { id: number; name: string; body: string; isDefault: boolean }

export const TEMPLATE_NAME_MAX = 120;
export const TEMPLATE_BODY_MAX = 5000;

type TemplateRow = { id: string; name: string; body: string; is_default: boolean };
const toTemplate = (r: TemplateRow): MessageTemplate => ({ id: Number(r.id), name: r.name, body: r.body, isDefault: r.is_default });

/** Все шаблоны: по умолчанию — первым, дальше по sort и id. */
export async function listTemplates(): Promise<MessageTemplate[]> {
  const r = await systemDb().query<TemplateRow>(
    `SELECT id::text AS id, name, body, is_default FROM repeat_kanban_templates ORDER BY is_default DESC, sort, id`,
  );
  return r.rows.map(toTemplate);
}

/** Шаблон по id, без id — по умолчанию (нет такого — первый по порядку). null — шаблонов нет. */
export async function getTemplate(id?: number | null): Promise<MessageTemplate | null> {
  const list = await listTemplates();
  if (id != null) return list.find(t => t.id === id) ?? null;
  return list.find(t => t.isDefault) ?? list[0] ?? null;
}

function validTemplateInput(input: { name?: unknown; body?: unknown }, partial: boolean): { name?: string; body?: string } {
  const out: { name?: string; body?: string } = {};
  if (input.name !== undefined || !partial) {
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    if (!name) throw new SettingsError('Укажите название шаблона');
    if (name.length > TEMPLATE_NAME_MAX) throw new SettingsError(`Название — не длиннее ${TEMPLATE_NAME_MAX} символов`);
    out.name = name;
  }
  if (input.body !== undefined || !partial) {
    const body = typeof input.body === 'string' ? input.body.replace(/\r\n/g, '\n').trim() : '';
    if (!body) throw new SettingsError('Текст шаблона пустой');
    if (body.length > TEMPLATE_BODY_MAX) throw new SettingsError(`Текст — не длиннее ${TEMPLATE_BODY_MAX} символов`);
    out.body = body;
  }
  return out;
}

/** Новый шаблон. Первый шаблон в таблице становится «по умолчанию» сам. */
export async function createTemplate(input: { name?: unknown; body?: unknown; isDefault?: unknown }, by: string): Promise<MessageTemplate> {
  const v = validTemplateInput(input, false);
  const client = await systemDb().connect();
  try {
    await client.query('BEGIN');
    const cnt = await client.query<{ n: string; mx: string | null }>(`SELECT count(*)::text AS n, max(sort)::text AS mx FROM repeat_kanban_templates`);
    const makeDefault = input.isDefault === true || Number(cnt.rows[0].n) === 0;
    if (makeDefault) await client.query(`UPDATE repeat_kanban_templates SET is_default = false WHERE is_default`);
    const r = await client.query<TemplateRow>(
      `INSERT INTO repeat_kanban_templates (name, body, is_default, sort, created_by, updated_by)
       VALUES ($1, $2, $3, $4, $5, $5) RETURNING id::text AS id, name, body, is_default`,
      [v.name, v.body, makeDefault, Number(cnt.rows[0].mx ?? -1) + 1, by],
    );
    await client.query('COMMIT');
    return toTemplate(r.rows[0]);
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/** Правка шаблона (частично). isDefault: true — снимает отметку с остальных;
 *  снять отметку с единственного «по умолчанию» нельзя — надо отметить другой. */
export async function updateTemplate(id: number, input: { name?: unknown; body?: unknown; isDefault?: unknown }, by: string): Promise<MessageTemplate> {
  const v = validTemplateInput(input, true);
  const client = await systemDb().connect();
  try {
    await client.query('BEGIN');
    const cur = await client.query<TemplateRow>(
      `SELECT id::text AS id, name, body, is_default FROM repeat_kanban_templates WHERE id = $1 FOR UPDATE`, [id],
    );
    if (!cur.rows[0]) throw new SettingsError('Шаблон не найден — возможно, его уже удалили');
    let isDefault = cur.rows[0].is_default;
    if (input.isDefault === true && !isDefault) {
      await client.query(`UPDATE repeat_kanban_templates SET is_default = false WHERE is_default`);
      isDefault = true;
    } else if (input.isDefault === false && isDefault) {
      throw new SettingsError('Шаблон по умолчанию должен быть всегда — отметьте другой, отметка снимется сама');
    }
    const r = await client.query<TemplateRow>(
      `UPDATE repeat_kanban_templates
          SET name = coalesce($2, name), body = coalesce($3, body), is_default = $4, updated_at = now(), updated_by = $5
        WHERE id = $1 RETURNING id::text AS id, name, body, is_default`,
      [id, v.name ?? null, v.body ?? null, isDefault, by],
    );
    await client.query('COMMIT');
    return toTemplate(r.rows[0]);
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/** Удалить шаблон. Удалили «по умолчанию» — отметка переходит к первому оставшемуся. */
export async function deleteTemplate(id: number): Promise<void> {
  const client = await systemDb().connect();
  try {
    await client.query('BEGIN');
    const del = await client.query<{ is_default: boolean }>(`DELETE FROM repeat_kanban_templates WHERE id = $1 RETURNING is_default`, [id]);
    if (!del.rows[0]) throw new SettingsError('Шаблон не найден — возможно, его уже удалили');
    if (del.rows[0].is_default) {
      await client.query(
        `UPDATE repeat_kanban_templates SET is_default = true
          WHERE id = (SELECT id FROM repeat_kanban_templates ORDER BY sort, id LIMIT 1)`,
      );
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

// ── Рендер шаблона ─────────────────────────────────────────────────────────

export const CLIENT_KEY_RE = /^[ckx]\d{1,12}$/;
export const MANAGER_ID_RE = /^\d{1,12}$/;

const DAY_MS = 86_400_000;
const rubFmt = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 });
const dateFmt = new Intl.DateTimeFormat('ru-RU', { timeZone: 'Europe/Moscow', day: '2-digit', month: '2-digit', year: 'numeric' });
const rub = (n: number) => `${rubFmt.format(Math.round(n))} ₽`;
const mskDay = (d: Date) => new Date(d.getTime() + 3 * 3600_000).toISOString().slice(0, 10);

/** «Кровля» → «кровля» посреди фразы, но аббревиатуры (ЖБИ, ОСБ-плиты) не трогаем. */
function midSentence(group: string): string {
  const g = group.trim();
  return g.length > 1 && g[0] !== g[0].toLowerCase() && g[1] === g[1].toLowerCase() && g[1] !== g[1].toUpperCase()
    ? g[0].toLowerCase() + g.slice(1) : g;
}
/** «a», «a и b», «a, b и c». Если в названиях групп уже есть «и» («теплоизоляция и утеплитель»),
 *  то только через запятую — иначе выходило «…утеплитель и окна и двери». */
function joinRu(items: string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  if (items.some(x => / и /i.test(x))) return items.join(', ');
  return `${items.slice(0, -1).join(', ')} и ${items[items.length - 1]}`;
}

async function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  let t: ReturnType<typeof setTimeout> | undefined;
  const timer = new Promise<T>(res => { t = setTimeout(() => res(fallback), ms); });
  try { return await Promise.race([p.catch(() => fallback), timer]); } finally { clearTimeout(t); }
}

interface Shipment { dealId: number; at: Date; amount: number; head: string | null; groups: string[] }

/** Отгрузки заказчика по той же формуле client_key, что у доски и «Моих заказчиков».
 *  Префильтр по contact_id/company_id — чтобы не гонять CASE по всей sa.deals. */
async function fetchShipments(clientKey: string): Promise<Shipment[]> {
  const r = await analyticsDb().query<{ deal_id: number; delivered_at: Date; amount: string | null; head_group_name: string | null; grps: string[] | null }>(
    `SELECT deal_id, delivered_at, amount, head_group_name, grps FROM (
       SELECT d.deal_id, d.delivered_at, d.amount::text AS amount, d.head_group_name,
              array(SELECT DISTINCT (p->>'head_group_name') FROM jsonb_array_elements(d.products) p
                     WHERE coalesce(p->>'type','') <> 'услуга' AND (p->>'head_group_name') IS NOT NULL
                       AND (p->>'head_group_name') !~* '^(доставка|перевозка|услуг|разное)') AS grps,
              (${CLIENT_KEY_CASE_SQL}) AS client_key
         FROM sa.deals d
        WHERE d.funnel_id IN (0,1,2,3) AND d.delivered_at IS NOT NULL
          AND (d.contact_id = $2 OR d.company_id = $2)
     ) t WHERE client_key = $1
     ORDER BY delivered_at, deal_id`,
    [clientKey, Number(clientKey.slice(1))],
  );
  return r.rows.map(x => ({
    dealId: Number(x.deal_id), at: new Date(x.delivered_at), amount: Math.round(Number(x.amount ?? 0)),
    head: x.head_group_name, groups: x.grps ?? [],
  }));
}

/** Число ПОКУПОК (правило владельца 21.09, lib/metrics/repeatRule.ts — то же, что
 *  purchasesDelivered «Моих заказчиков»): новая покупка — первая отгрузка, другая
 *  головная группа или разрыв от REPEAT_SPLIT_GAP_DAYS дней с предыдущей отгрузкой. */
function countPurchases(list: Shipment[]): number {
  let n = 0;
  list.forEach((s, i) => {
    const prev = list[i - 1];
    if (!prev || s.head !== prev.head || s.at.getTime() >= prev.at.getTime() + REPEAT_SPLIT_GAP_DAYS * DAY_MS) n++;
  });
  return n;
}

/** Группы отгрузки: головная — первой, дальше остальные из состава (до трёх). */
function shipmentGroups(s: Shipment): string[] {
  const out: string[] = [];
  for (const g of [s.head, ...s.groups]) if (g && !out.includes(g) && !/^(доставка|перевозка|услуг|разное)/i.test(g)) out.push(g);
  return out.slice(0, 3);
}

/** Рекомендации — ТЕ ЖЕ, что показывает карточка клиента (fetchClientModule →
 *  recommendations.client: цепочка стройки + история + ручные приоритеты, «не предлагать»).
 *  'x' (юр-сделка без карточки компании) — это контакт, карточка открывается по нему.
 *  Карточка не собралась/пусто — кросс-селл «Моих заказчиков» по группам последней отгрузки. */
// Кэш рекомендаций на 10 минут: окно задачи, смена шаблона и массовая постановка спрашивают
// одного и того же заказчика по нескольку раз.
const REC_TTL_MS = 10 * 60_000;
const recCache = new Map<string, { at: number; groups: string[] }>();

async function recommendedGroups(clientKey: string, lastGroups: string[]): Promise<string[]> {
  const ref = (clientKey.startsWith('k') ? `k${clientKey.slice(1)}` : `c${clientKey.slice(1)}`) as `c${number}` | `k${number}`;
  const hit = recCache.get(ref);
  if (hit && Date.now() - hit.at < REC_TTL_MS && hit.groups.length) return hit.groups;
  try {
    const { fetchClientModule } = await import('@/features/client-module/engine/clientModule');
    // light: только наша БД — без Битрикса, геокодера и ЕГРЮЛ (было 3–5 с на открытие окна).
    const card = await withTimeout(fetchClientModule(ref, { light: true }), 6_000, null);
    const groups = card?.recommendations.client.map(r => r.group).filter(Boolean) ?? [];
    if (groups.length) {
      if (recCache.size > 5000) recCache.clear();
      recCache.set(ref, { at: Date.now(), groups: groups.slice(0, 3) });
      return groups.slice(0, 3);
    }
  } catch (e) {
    console.warn('[repeat-kanban template] рекомендации карточки клиента:', e instanceof Error ? e.message : e);
  }
  if (!lastGroups.length) return [];
  try {
    const [matrix, priorities] = await Promise.all([fetchCrossSellMatrix(), fetchCrossSellPriorities()]);
    return recommendFor(matrix, lastGroups, priorities)?.items.map(i => i.group).slice(0, 3) ?? [];
  } catch (e) {
    console.warn('[repeat-kanban template] кросс-селл:', e instanceof Error ? e.message : e);
    return [];
  }
}

async function managerName(managerId: string): Promise<string | null> {
  if (!MANAGER_ID_RE.test(managerId)) return null;
  const r = await analyticsDb().query<{ manager_name: string | null }>(
    `SELECT manager_name FROM sa.org_resolved_hierarchy WHERE manager_bitrix_user_id = $1 LIMIT 1`, [managerId],
  );
  return r.rows[0]?.manager_name?.trim() || null;
}

async function clientName(clientKey: string): Promise<string | null> {
  const names = await withTimeout(resolveClientNames([clientKey]), 5000, null)
    ?? await getCachedClientNames([clientKey]).catch(() => new Map<string, string | null>());
  return names.get(clientKey)?.trim() || null;
}

/** Значения плейсхолдеров одного заказчика — лениво, каждый ключ считается при первом
 *  обращении; общие куски (отгрузки) — один запрос на всех. */
function contextFor(clientKey: string, managerId: string): Map<string, () => Promise<string>> {
  let shipP: Promise<Shipment[]> | null = null;
  const ship = () => (shipP ??= fetchShipments(clientKey));
  const last = async () => { const l = await ship(); return l[l.length - 1] ?? null; };
  const memo = (f: () => Promise<string>) => { let p: Promise<string> | null = null; return () => (p ??= f()); };

  return new Map<string, () => Promise<string>>([
    ['client', memo(async () => (await clientName(clientKey)) ?? 'заказчик')],
    ['manager', memo(async () => (await managerName(managerId)) ?? 'менеджер')],
    ['last_purchase', memo(async () => {
      const s = await last();
      if (!s) return 'материалы (отгрузок в базе не нашли)';
      const groups = shipmentGroups(s).map(midSentence);
      const what = groups.length ? joinRu(groups) : 'материалы';
      return `${what} ${dateFmt.format(s.at)}${s.amount > 0 ? ` на ${rub(s.amount)}` : ''}`;
    })],
    ['recommended', memo(async () => {
      const s = await last();
      const groups = await recommendedGroups(clientKey, s ? shipmentGroups(s) : []);
      return groups.length ? joinRu(groups.map(midSentence)) : 'сопутствующие материалы';
    })],
    ['days_since', memo(async () => {
      const s = await last();
      if (!s) return '—';
      return String(Math.max(0, Math.round((Date.parse(mskDay(new Date())) - Date.parse(mskDay(s.at))) / DAY_MS)));
    })],
    ['shipments', memo(async () => String(countPurchases(await ship())))],
    ['ltv', memo(async () => rub((await ship()).reduce((sum, s) => sum + s.amount, 0)))],
    ['window_until', memo(async () => {
      const s = await last();
      if (!s) return 'окно уже закрыто';
      const until = new Date(s.at.getTime() + WINDOW_DAYS * DAY_MS);
      return Date.now() > until.getTime() ? 'окно уже закрыто' : dateFmt.format(until);
    })],
  ]);
}

const FALLBACK: Record<string, string> = { recommended: 'сопутствующие материалы', client: 'заказчик', manager: 'менеджер' };

/** Подставляет плейсхолдеры ({{client}} или русское название {{Заказчик}}). Неизвестные
 *  оставляет как есть. Не смогли посчитать кусок — нейтральная заглушка, не ошибка. */
export async function renderTemplate(body: string, ctx: { clientKey: string; managerId: string }): Promise<string> {
  if (!CLIENT_KEY_RE.test(ctx.clientKey)) throw new SettingsError('Некорректный заказчик');
  const values = contextFor(ctx.clientKey, ctx.managerId);
  const needed = new Set<string>();
  for (const m of body.matchAll(PLACEHOLDER_RE)) { const k = placeholderKey(m[1]); if (k && values.has(k)) needed.add(k); }
  const resolved = new Map<string, string>();
  await Promise.all([...needed].map(async k => {
    try {
      resolved.set(k, await values.get(k)!());
    } catch (e) {
      console.warn(`[repeat-kanban template] {{${k}}} для ${ctx.clientKey}:`, e instanceof Error ? e.message : e);
      resolved.set(k, FALLBACK[k] ?? '—');
    }
  }));
  return body.replace(PLACEHOLDER_RE, (m, raw: string) => {
    const k = placeholderKey(raw);
    return k && resolved.has(k) ? resolved.get(k)! : m;
  });
}

/** Любой заказчик с последней отгрузкой (для предпросмотра в редакторе шаблонов). */
export async function sampleClient(): Promise<{ clientKey: string; managerId: string } | null> {
  const r = await analyticsDb().query<{ client_key: string | null; mgr: string | null }>(
    `SELECT (${CLIENT_KEY_CASE_SQL}) AS client_key, d.current_manager_id::text AS mgr
       FROM sa.deals d
      WHERE d.funnel_id IN (0,1,2,3) AND d.delivered_at IS NOT NULL AND d.delivered_at <= now()
        AND d.current_manager_id IS NOT NULL
      ORDER BY d.delivered_at DESC, d.deal_id DESC LIMIT 20`,
  );
  const row = r.rows.find(x => x.client_key && CLIENT_KEY_RE.test(x.client_key) && x.mgr);
  return row ? { clientKey: row.client_key!, managerId: row.mgr! } : null;
}

/** Менеджер заказчика по атрибуции (последняя сделка), как у доски. */
export async function clientManagerId(clientKey: string): Promise<string | null> {
  if (!CLIENT_KEY_RE.test(clientKey)) return null;
  const r = await analyticsDb().query<{ mgr: string | null }>(
    `SELECT mgr FROM (
       SELECT d.current_manager_id::text AS mgr, d.created_at, d.deal_id, (${CLIENT_KEY_CASE_SQL}) AS client_key
         FROM sa.deals d
        WHERE d.funnel_id IN (0,1,2,3) AND (d.contact_id = $2 OR d.company_id = $2)
     ) t WHERE client_key = $1 ORDER BY created_at DESC NULLS LAST, deal_id DESC LIMIT 1`,
    [clientKey, Number(clientKey.slice(1))],
  );
  return r.rows[0]?.mgr ?? null;
}
