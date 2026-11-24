// Сбор всего, что висит на аккаунте сотрудника, — ЖИВЫМ чтением из Битрикса. Копии sa.* не годятся:
// у проданных сделок ответственный заморожен триггером (seller-freeze), задачи и дела отстают.
// Только чтение, постранично (start/next), пауза ~500 мс между страницами.
//
// v2 (24.11): только ОТКРЫТЫЕ сделки первичных (0,1,4,7) и повторных (2,3) воронок; лиды, контакты, компании и
// закрытые сделки не собираем (БП 171 сам переводит компанию/контакт/лид и дела сделки). Квалификация первички —
// по справочнику стадий sa.stages (event_type) и сумме; ценность заказчика повторки — по sa.deals (как «Мои
// заказчики» / канбан повторных: ключ заказчика CLIENT_KEY_SQL + склейка merge.ts, LTV = сумма отгруженных
// сделок, отгрузки = число отгруженных сделок). Задачи и дела делятся на «по его открытой сделке» и прочие.
import { cached } from '@/lib/cache/redis';
import { analyticsDb } from '@/lib/db/clients';
import { resolveClientNames } from '@/lib/bitrix/clientNames';
import { CLIENT_KEY_SQL } from '@/features/customers/engine/clientKey';
import { fetchAliasMap, type AliasInfo } from '@/features/customers/engine/merge';
import { ropOfManager } from '@/features/repeat-kanban/engine/createDeal';
import {
  PRIMARY_BRAK_STAGE, PRIMARY_FUNNELS, PRIMARY_MIN_AMOUNT, REPEAT_FUNNELS,
  type DismissalItemInfo, type DismissalKind,
} from '../types';
import { dealUrl, fmtDate, fmtMoney, ownerUrl, readAll, sleep, taskUrl } from './bx';

export interface ScannedItem {
  key: string;
  kind: DismissalKind;
  ord: number;
  entityId: number;
  title: string;
  url: string | null;
  subtitle: string | null;
  /** для UI (DismissalItem.info) */
  info: DismissalItemInfo;
  /** служебное для исполнителя (роль в задаче, тип дела, owner, …) */
  meta: Record<string, unknown>;
}
export interface ScanResult { items: ScannedItem[]; ropBitrixId: number | null }

const join = (...parts: (string | null | undefined | false)[]) => parts.filter(Boolean).join(' · ') || null;
const num = (v: unknown) => Number(v) || 0;
const money = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 });

/** «Бронь+»: стадии брони, подтверждения, продажи (и отгрузки — если открытая сделка вдруг там). */
const QUALIFIED_EVENTS = new Set(['reserved', 'confirmed', 'sold', 'shipped']);

/** Названия стадий сделок (crm.status.list, сутки в кэше) — запасной источник имени, если стадии нет в sa.stages. */
async function liveStageNames(): Promise<Record<string, string>> {
  return cached('dismissal:deal-stages:v2', 24 * 3600, async () => {
    const rows = await readAll<{ ENTITY_ID: string; STATUS_ID: string; NAME: string }>('crm.status.list', { order: { SORT: 'ASC' } }, { pauseMs: 300 });
    const out: Record<string, string> = {};
    for (const r of rows) if (r.ENTITY_ID?.startsWith('DEAL_STAGE')) out[r.STATUS_ID] = r.NAME;
    return out;
  }).catch(() => ({}));
}

/** Справочник стадий проекта: id (= живой STAGE_ID Битрикса) → имя и event_type. */
async function stageRefs(ids: string[]): Promise<Map<string, { name: string | null; eventType: string | null }>> {
  if (!ids.length) return new Map();
  const r = await analyticsDb().query<{ id: string; name: string | null; event_type: string | null }>(
    'SELECT id::text, name, event_type FROM sa.stages WHERE id::text = ANY($1::text[])', [ids],
  );
  return new Map(r.rows.map(x => [x.id, { name: x.name, eventType: x.event_type }]));
}

/** Ключ заказчика сделки — та же формула, что CLIENT_KEY_SQL (features/customers/engine/clientKey.ts). */
function rawClientKey(funnel: number, contactId: number, companyId: number): string | null {
  if (funnel === 0 || funnel === 2) return contactId ? `c${contactId}` : null;
  if (!companyId && contactId) return `x${contactId}`;
  if (companyId) return `k${companyId}`;
  return null;
}

/** LTV (сумма отгруженного) и число отгрузок по каноничным ключам заказчиков — все сделки воронок 0–3, со склейкой. */
async function clientValues(keys: string[], aliases: Map<string, AliasInfo>): Promise<Map<string, { ltv: number; shipments: number }>> {
  if (!keys.length) return new Map();
  const want = new Set(keys);
  const members: string[] = [], primaries: string[] = [];
  for (const [m, a] of aliases) if (want.has(a.primary)) { members.push(m); primaries.push(a.primary); }
  const raw = [...new Set([...keys, ...members])];
  const r = await analyticsDb().query<{ client_key: string; ltv: string; shipments: number }>(
    `WITH cd AS (
       SELECT coalesce(al.primary_key, t.raw_key) AS client_key, t.amount
         FROM (SELECT d.amount, (${CLIENT_KEY_SQL}) AS raw_key FROM sa.deals d
                WHERE d.funnel_id IN (0,1,2,3) AND d.delivered_at IS NOT NULL) t
         LEFT JOIN unnest($1::text[], $2::text[]) AS al(member_key, primary_key) ON al.member_key = t.raw_key
        WHERE t.raw_key = ANY($3::text[]))
     SELECT client_key, coalesce(sum(amount), 0)::text AS ltv, count(*)::int AS shipments FROM cd
      WHERE client_key = ANY($4::text[]) GROUP BY 1`,
    [members, primaries, raw, keys],
  );
  return new Map(r.rows.map(x => [x.client_key, { ltv: Math.round(Number(x.ltv)), shipments: x.shipments }]));
}

const TASK_STATUS: Record<number, string> = { 1: 'новая', 2: 'ждёт выполнения', 3: 'выполняется', 4: 'ждёт контроля', 6: 'отложена' };
const ACTIVITY_TYPE: Record<number, string> = { 1: 'Встреча', 2: 'Звонок', 4: 'Письмо', 6: 'Дело' };
const OWNER_LABEL: Record<number, string> = { 1: 'лид', 2: 'сделка', 3: 'контакт', 4: 'компания' };

interface BxTask {
  id: string; title?: string; status?: string; deadline?: string | null; responsibleId?: string; createdBy?: string;
  accomplices?: string[]; auditors?: string[]; groupId?: string; ufCrmTask?: string[] | string | null;
}
const taskList = (filter: Record<string, unknown>, onPage?: () => Promise<void> | void) => readAll<BxTask>('tasks.task.list', {
  filter: { ...filter, '!STATUS': 5 },
  select: ['ID', 'TITLE', 'STATUS', 'DEADLINE', 'RESPONSIBLE_ID', 'CREATED_BY', 'ACCOMPLICES', 'AUDITORS', 'GROUP_ID', 'UF_CRM_TASK'],
  order: { ID: 'asc' },
}, { pick: r => ((r as { tasks?: BxTask[] })?.tasks ?? []), onPage });

/**
 * Полный сбор по аккаунту. onProgress — после каждой страницы (воркер отмечает heartbeat).
 * Порядок строк: первичка — по id сделки; повторка — по рангу заказчика, внутри — по id; прочее — по id.
 */
export async function scanAccount(sourceId: number, onProgress?: (stage: string) => Promise<void> | void): Promise<ScanResult> {
  const items: ScannedItem[] = [];
  const ordOf: Partial<Record<DismissalKind, number>> = {};
  const push = (it: Omit<ScannedItem, 'key' | 'ord'>) => {
    const ord = (ordOf[it.kind] = (ordOf[it.kind] ?? 0) + 1);
    items.push({ ...it, key: `${it.kind}:${it.entityId}`, ord });
  };
  const tick = (stage: string) => () => onProgress?.(stage);

  // ── Открытые сделки первичных и повторных воронок ─────────────────────────
  const funnels = [...PRIMARY_FUNNELS, ...REPEAT_FUNNELS] as number[];
  const deals = (await readAll<Record<string, string | null>>('crm.deal.list', {
    filter: { ASSIGNED_BY_ID: sourceId, STAGE_SEMANTIC_ID: 'P', CATEGORY_ID: funnels },
    select: ['ID', 'TITLE', 'STAGE_ID', 'STAGE_SEMANTIC_ID', 'CLOSED', 'OPPORTUNITY', 'CURRENCY_ID', 'CATEGORY_ID', 'DATE_CREATE', 'CONTACT_ID', 'COMPANY_ID'],
    order: { ID: 'ASC' },
  }, { onPage: tick('deals') })).filter(d => num(d.ID) && d.CLOSED !== 'Y' && (d.STAGE_SEMANTIC_ID ?? 'P') === 'P' && funnels.includes(num(d.CATEGORY_ID)));
  const [refs, live] = await Promise.all([stageRefs([...new Set(deals.map(d => String(d.STAGE_ID ?? '')).filter(Boolean))]), liveStageNames()]);
  const stageName = (id: string | null) => (id ? refs.get(id)?.name ?? live[id] ?? id : null);

  /** id открытой сделки → ключ строки прогона (для задач/дел «по сделке»). */
  const dealKeyOf = new Map<number, string>();

  // Первичка: квалификация «бронь+ или чек ≥ PRIMARY_MIN_AMOUNT».
  for (const d of deals.filter(x => (PRIMARY_FUNNELS as readonly number[]).includes(num(x.CATEGORY_ID)))) {
    const id = num(d.ID), funnel = num(d.CATEGORY_ID), stageId = String(d.STAGE_ID ?? '');
    const amount = Number(d.OPPORTUNITY) || 0;
    const ref = refs.get(stageId);
    const name = stageName(stageId);
    const byStage = !!ref?.eventType && QUALIFIED_EVENTS.has(ref.eventType);
    const byAmount = amount >= PRIMARY_MIN_AMOUNT;
    const qualifyReason = byStage
      ? `стадия «${name}» — бронь и дальше`
      : byAmount
        ? `чек ${money.format(amount)} ₽ ≥ ${money.format(PRIMARY_MIN_AMOUNT)} ₽`
        : `${ref ? 'не бронь' : 'стадии нет в справочнике'}, чек ${money.format(amount)} ₽ < ${money.format(PRIMARY_MIN_AMOUNT)} ₽`;
    const brakStage = PRIMARY_BRAK_STAGE[funnel];
    push({
      kind: 'deal_primary', entityId: id, title: d.TITLE?.trim() || `Сделка #${id}`, url: dealUrl(id),
      subtitle: join(name, fmtMoney(d.OPPORTUNITY, d.CURRENCY_ID), `создана ${fmtDate(d.DATE_CREATE) ?? '—'}`),
      info: { funnelId: funnel, stageName: name ?? undefined, amount, qualified: byStage || byAmount, qualifyReason, brakAvailable: !!brakStage && stageId !== brakStage },
      meta: { stageId, funnelId: funnel, brakStage: brakStage ?? null, contactId: num(d.CONTACT_ID) || null, companyId: num(d.COMPANY_ID) || null },
    });
    dealKeyOf.set(id, `deal_primary:${id}`);
  }
  await onProgress?.('primary');

  // Повторка: заказчик → LTV/отгрузки, ранг по LTV, затем по отгрузкам; у сделок одного заказчика ранг общий.
  const repeat = deals.filter(x => (REPEAT_FUNNELS as readonly number[]).includes(num(x.CATEGORY_ID)));
  if (repeat.length) {
    const aliases = await fetchAliasMap().catch(() => new Map<string, AliasInfo>());
    const rows = repeat.map(d => {
      const raw = rawClientKey(num(d.CATEGORY_ID), num(d.CONTACT_ID), num(d.COMPANY_ID));
      return { d, key: raw ? aliases.get(raw)?.primary ?? raw : null };
    });
    const keys = [...new Set(rows.map(r => r.key).filter((k): k is string => !!k))];
    const values = await clientValues(keys, aliases);
    // Имена — из кэша имён Битрикса (как у карточки заказчика); x-ключ — это контакт.
    const nameKey = (k: string) => (k.startsWith('x') ? `c${k.slice(1)}` : k);
    const names = await resolveClientNames([...new Set(keys.map(nameKey))]).catch(() => new Map<string, string | null>());
    const clients = keys.map(k => ({ key: k, ltv: values.get(k)?.ltv ?? 0, shipments: values.get(k)?.shipments ?? 0 }))
      .sort((a, b) => b.ltv - a.ltv || b.shipments - a.shipments || a.key.localeCompare(b.key));
    const rankOf = new Map(clients.map((c, i) => [c.key, i + 1]));
    const noKeyRank = clients.length + 1; // сделки без заказчика — в хвост, общим рангом
    const rankFor = (k: string | null) => (k ? rankOf.get(k)! : noKeyRank);
    rows.sort((a, b) => rankFor(a.key) - rankFor(b.key) || num(a.d.ID) - num(b.d.ID));
    for (const { d, key } of rows) {
      const id = num(d.ID), stageId = String(d.STAGE_ID ?? '');
      const v = key ? values.get(key) : undefined;
      // В Битриксе у части контактов имя буквально «-» (заведены без имени) — такое за имя не считаем.
      const rawName = key ? names.get(nameKey(key))?.trim() : undefined;
      const realName = rawName && !/^[-—–.\s]*$/.test(rawName) ? rawName : null;
      const clientName = key
        ? realName ?? `${key.startsWith('k') ? 'Компания' : 'Контакт'} #${key.slice(1)}${d.TITLE?.trim() ? ` (${d.TITLE.trim()})` : ''}`
        : 'Заказчик не указан';
      const ltv = v?.ltv ?? 0, shipments = v?.shipments ?? 0;
      push({
        kind: 'deal_repeat', entityId: id, title: d.TITLE?.trim() || `Сделка #${id}`, url: dealUrl(id),
        subtitle: join(clientName, `LTV ${money.format(ltv)} ₽`, `отгрузок ${shipments}`, stageName(stageId), fmtMoney(d.OPPORTUNITY, d.CURRENCY_ID)),
        info: {
          funnelId: num(d.CATEGORY_ID), stageName: stageName(stageId) ?? undefined, amount: Number(d.OPPORTUNITY) || 0,
          clientKey: key ?? undefined, clientName, ltv, shipments, rank: rankFor(key),
        },
        meta: { stageId, funnelId: num(d.CATEGORY_ID), contactId: num(d.CONTACT_ID) || null, companyId: num(d.COMPANY_ID) || null },
      });
      dealKeyOf.set(id, `deal_repeat:${id}`);
    }
  }
  await sleep(500);

  // ── Задачи (только незавершённые) ─────────────────────────────────────────
  const taskSub = (t: BxTask, role?: string, extra?: string | null) => join(role, extra, TASK_STATUS[num(t.status)] ?? null, t.deadline ? `срок ${fmtDate(t.deadline)}` : 'без срока');
  const alive = (t: BxTask) => ![5, 7].includes(num(t.status));
  const crmRefs = (t: BxTask) => (Array.isArray(t.ufCrmTask) ? t.ufCrmTask : t.ufCrmTask ? [t.ufCrmTask] : []).map(String);
  const asResp = (await taskList({ RESPONSIBLE_ID: sourceId }, tick('tasks'))).filter(alive);
  for (const t of asResp) {
    const id = num(t.id);
    if (!id) continue;
    const creatorIsSource = num(t.createdBy) === sourceId;
    // Привязка к его открытой сделке из прогона: UF_CRM_TASK содержит D_<id>.
    const dealId = crmRefs(t).map(x => Number(/^D_(\d+)$/.exec(x)?.[1])).find(n => n && dealKeyOf.has(n));
    const role = creatorIsSource ? 'исполнитель и постановщик' : 'исполнитель';
    push({
      kind: dealId ? 'task_deal' : 'task_other', entityId: id, title: t.title?.trim() || `Задача #${id}`, url: taskUrl(id, sourceId),
      subtitle: taskSub(t, role, dealId ? `сделка #${dealId}` : null),
      info: { deadline: t.deadline ?? null, role, ...(dealId ? { dealKey: dealKeyOf.get(dealId)! } : {}) },
      meta: { status: num(t.status), createdBy: num(t.createdBy), creatorIsSource, groupId: num(t.groupId) || null, dealId: dealId ?? null },
    });
  }
  await sleep(500);
  const asCreator = (await taskList({ CREATED_BY: sourceId, '!RESPONSIBLE_ID': sourceId }, tick('tasks'))).filter(alive);
  for (const t of asCreator) {
    const id = num(t.id);
    if (!id || num(t.responsibleId) === sourceId) continue;
    push({
      kind: 'task_creator', entityId: id, title: t.title?.trim() || `Задача #${id}`, url: taskUrl(id, num(t.responsibleId)),
      subtitle: taskSub(t, 'постановщик'), info: { deadline: t.deadline ?? null, role: 'постановщик' },
      meta: { status: num(t.status), responsibleId: num(t.responsibleId), groupId: num(t.groupId) || null },
    });
  }
  await sleep(500);
  // Соисполнитель / наблюдатель: одна строка на задачу, роли — в meta (может быть обеими сразу).
  const part = new Map<number, { t: BxTask; roles: Set<'accomplice' | 'auditor'> }>();
  for (const [field, role] of [['ACCOMPLICE', 'accomplice'], ['AUDITOR', 'auditor']] as const) {
    const list = (await taskList({ [field]: sourceId }, tick('tasks'))).filter(alive);
    for (const t of list) {
      const id = num(t.id);
      if (!id || num(t.responsibleId) === sourceId) continue; // исполнитель — уже в task_deal / task_other
      const cur = part.get(id) ?? { t, roles: new Set() };
      cur.roles.add(role);
      part.set(id, cur);
    }
    await sleep(500);
  }
  for (const [id, { t, roles }] of [...part].sort((a, b) => a[0] - b[0])) {
    const label = [roles.has('accomplice') && 'соисполнитель', roles.has('auditor') && 'наблюдатель'].filter(Boolean).join(' и ');
    push({
      kind: 'task_participant', entityId: id, title: t.title?.trim() || `Задача #${id}`, url: taskUrl(id, num(t.responsibleId)),
      subtitle: taskSub(t, label), info: { deadline: t.deadline ?? null, role: label },
      meta: { status: num(t.status), roles: [...roles], responsibleId: num(t.responsibleId), createdBy: num(t.createdBy) },
    });
  }

  // ── Дела CRM (незавершённые) ──────────────────────────────────────────────
  // Не дела по сути (сверено на живом аккаунте 24.11): TYPE_ID 3 / CRM_TASKS_TASK — отражения задач (их ведёт
  // сама задача, виды task_*); CRM_BIZPROC_WORKFLOW — служебная запись «Бизнес-процесс завершён», висит
  // «невыполненной» вечно (у одного менеджера 39 из 42).
  const NOT_TODO = new Set(['CRM_TASKS_TASK', 'TASKS_TASK', 'TASKS', 'CRM_BIZPROC_WORKFLOW']);
  const acts = await readAll<Record<string, string | null>>('crm.activity.list', {
    filter: { RESPONSIBLE_ID: sourceId, COMPLETED: 'N' },
    select: ['ID', 'SUBJECT', 'TYPE_ID', 'PROVIDER_ID', 'PROVIDER_TYPE_ID', 'OWNER_TYPE_ID', 'OWNER_ID', 'DEADLINE', 'START_TIME', 'DIRECTION'],
    order: { ID: 'ASC' },
  }, { onPage: tick('activities') });
  for (const a of acts) {
    const id = num(a.ID);
    if (!id) continue;
    const typeId = num(a.TYPE_ID);
    if (typeId === 3 || NOT_TODO.has(String(a.PROVIDER_ID ?? ''))) continue;
    const ownerType = num(a.OWNER_TYPE_ID), ownerId = num(a.OWNER_ID);
    const dealKey = ownerType === 2 ? dealKeyOf.get(ownerId) : undefined;
    const deadlineRaw = a.DEADLINE && !String(a.DEADLINE).startsWith('9999') ? a.DEADLINE : null;
    const deadline = deadlineRaw ? fmtDate(deadlineRaw) : null;
    push({
      kind: dealKey ? 'activity_deal' : 'activity_other', entityId: id,
      title: a.SUBJECT?.trim() || `${ACTIVITY_TYPE[typeId] ?? 'Дело'} #${id}`, url: ownerUrl(ownerType, ownerId),
      subtitle: join(a.PROVIDER_ID === 'CRM_TODO' ? 'Дело' : (ACTIVITY_TYPE[typeId] ?? 'Дело'), OWNER_LABEL[ownerType] && `${OWNER_LABEL[ownerType]} #${ownerId}`, deadline ? `срок ${deadline}` : 'без срока'),
      info: { deadline: deadlineRaw, ...(dealKey ? { dealKey } : {}) },
      meta: { typeId, providerId: a.PROVIDER_ID, ownerTypeId: ownerType, ownerId },
    });
  }

  // ── РОП уволенного: получатель «без сделок» и адресат сообщения ────────────
  const rop = Number(await ropOfManager(String(sourceId)).catch(() => null)) || null;
  return { items, ropBitrixId: rop && rop !== sourceId ? rop : null };
}
