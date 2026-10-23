// Сбор данных по заказчику для ИИ-анализа звонков (BACKLOG «ИИ-анализ звонков заказчика», этап 0).
//
// Заказчик — ClientRef карточки клиента (c<contact> — контакт со всеми его сделками, в т.ч. юр без
// компании; k<company> — компания) плюс все карточки, склеенные с ним (`memberKeysOf`: один человек
// бывал и контактом, и компанией). Звонки va.calls привязаны к случайной сделке заказчика, поэтому
// берём звонки по ВСЕМ его сделкам, а не по одной.
//
// Тексты: va.transcriptions — formatted_dialogue (по репликам) часто пуст, тогда raw_text (сплошной,
// без ролей). Короткие звонки (≤ 15 с, недозвоны) не расшифровываются — их нет в transcriptions.
//
// «Факты из CRM» считает код, не модель: проверка 22.10 показала, что модель принимает отказную
// стадию за правду («Больше ничего не нужно» при нуле звонков по сделке), а кодом это однозначно.
//
// Имя менеджера — из оргструктуры (как карточка клиента, history.ts): в sa.employees.full_name у части
// сотрудников должность вместо имени («Стажер», найдено 23.10).
import { analyticsDb } from '@/lib/db/clients';
import { CLIENT_KEY_SQL } from '@/features/customers/engine/clientKey';
import { memberKeysOf } from '@/features/customers/engine/merge';
import type { ClientRef } from '@/features/client-module/engine/types';

/** Окно истории: звонки старше не берём (вход модели и цена растут, пользы мало). */
export const HISTORY_MONTHS = 12;
/** Потолок текста звонков в символах (~100 тыс. токенов): дальше — отрезаем самые старые. */
export const MAX_CALLS_CHARS = 300_000;

export interface CollectedDeal {
  dealId: number; name: string | null; funnel: string | null; stageId: string | null; stage: string | null;
  createdAt: string | null; deliveredAt: string | null; amount: number; group: string | null; manager: string | null;
  products: string;
  /** Товарные группы сделки: head-группа сделки и head-группы позиций (без услуг/доставки) — для связок. */
  groups: string[];
  /** shipped — отгружена; lost — закрыта в отказ (стадия LOSE/APOLOGY/отказные); open — в работе. */
  state: 'shipped' | 'lost' | 'open';
}
export interface CollectedCall {
  id: string; calledAt: string; dealId: number; direction: string | null; durationSec: number | null;
  stage: string | null; manager: string | null; text: string; hasRoles: boolean;
}
export interface ClientCallData {
  ref: ClientRef;
  memberKeys: string[];
  clientType: string | null;
  deals: CollectedDeal[];
  calls: CollectedCall[];
  callsTotal: number;
  callsCompleted: number;
  /** Расшифровки, не попавшие в анализ из-за окна/потолка. */
  callsTrimmed: number;
  facts: string[];
}

const LOST_STAGES = ['C2:LOSE', 'C2:APOLOGY', 'C2:1', 'C2:2', 'C3:LOSE', 'C3:APOLOGY', 'C3:2'];
const mskDate = (d: Date | string | null) => (d ? new Date(new Date(d).getTime() + 3 * 3600_000).toISOString().slice(0, 10) : null);

/** Ключи заказчика в терминах CLIENT_KEY_SQL (c/x — контакт, k — компания) со склейкой. */
export async function clientKeys(ref: ClientRef): Promise<string[]> {
  const id = ref.slice(1);
  const seeds = ref.startsWith('k') ? [`k${id}`] : [`c${id}`, `x${id}`];
  const all = new Set<string>();
  for (const s of seeds) for (const k of await memberKeysOf(s)) all.add(k);
  return [...all];
}

export async function collectClientData(ref: ClientRef): Promise<ClientCallData> {
  const db = analyticsDb();
  const keys = await clientKeys(ref);

  const deals = (await db.query<{
    deal_id: number; deal_name: string | null; funnel: string | null; stage_id: string | null; stage: string | null;
    created_at: Date | null; delivered_at: Date | null; amount: string | null; grp: string | null; manager: string | null; products: unknown;
    stage_type: string | null; lost_at: Date | null;
  }>(
    `SELECT d.deal_id, d.deal_name, f.name AS funnel, d.stage_id, s.name AS stage, s.stage_type, d.lost_at, d.created_at, d.delivered_at,
            d.amount, d.head_group_name AS grp, coalesce(org.manager_name, e.full_name) AS manager, d.products
       FROM sa.deals d
       LEFT JOIN sa.funnels f ON f.id = d.funnel_id
       LEFT JOIN sa.stages s ON s.id = d.stage_id
       LEFT JOIN sa.employees e ON e.bitrix_id = d.current_manager_id
       LEFT JOIN sa.org_resolved_hierarchy org ON org.manager_bitrix_user_id = d.current_manager_id::text
      WHERE d.funnel_id IN (0,1,2,3) AND (${CLIENT_KEY_SQL}) = ANY($1::text[])
      ORDER BY d.created_at, d.deal_id`,
    [keys],
  )).rows;
  const dealIds = deals.map(d => Number(d.deal_id));

  const [calls, totals, profile] = await Promise.all([
    db.query<{ id: string; called_at: Date; deal_id: number; direction: string | null; dur: number | null; stage: string | null; manager: string | null; txt: string | null; roles: boolean }>(
      `SELECT c.id::text, c.called_at, c.deal_id, c.direction::text, c.duration_seconds AS dur, c.stage_at_call_time AS stage,
              coalesce(org.manager_name, e.full_name) AS manager, coalesce(t.formatted_dialogue, t.raw_text) AS txt, (t.formatted_dialogue IS NOT NULL) AS roles
         FROM va.calls c
         JOIN va.transcriptions t ON t.call_id = c.id
         LEFT JOIN sa.employees e ON e.bitrix_id = c.manager_id
       LEFT JOIN sa.org_resolved_hierarchy org ON org.manager_bitrix_user_id = c.manager_id::text
        WHERE c.failed_at_stage IS NULL AND c.deal_id = ANY($1::bigint[]) AND c.called_at >= now() - make_interval(months => $2)
        ORDER BY c.called_at`,
      [dealIds, HISTORY_MONTHS],
    ),
    db.query<{ total: number; completed: number; texts_old: number }>(
      `SELECT count(*)::int AS total, count(*) FILTER (WHERE c.result = 'completed')::int AS completed,
              count(t.id) FILTER (WHERE c.called_at < now() - make_interval(months => $2))::int AS texts_old
         FROM va.calls c LEFT JOIN va.transcriptions t ON t.call_id = c.id
        WHERE c.failed_at_stage IS NULL AND c.deal_id = ANY($1::bigint[])`,
      [dealIds, HISTORY_MONTHS],
    ),
    db.query<{ client_type: string | null }>(`SELECT client_type FROM sa.client_module_profiles WHERE client_ref = $1`, [ref]),
  ]);

  // Потолок по объёму: оставляем самые свежие звонки.
  let rows = calls.rows.filter(r => (r.txt ?? '').trim() && r.txt !== 'null');
  let chars = 0, cut = 0;
  for (let i = rows.length - 1; i >= 0; i--) {
    chars += rows[i].txt!.length;
    if (chars > MAX_CALLS_CHARS) { cut = i + 1; break; }
  }
  const trimmedByCap = cut;
  rows = rows.slice(cut);

  const facts = await crmFacts(deals, dealIds);

  return {
    ref, memberKeys: keys,
    clientType: profile.rows[0]?.client_type ?? null,
    deals: deals.map(d => ({
      dealId: Number(d.deal_id), name: d.deal_name, funnel: d.funnel, stageId: d.stage_id, stage: d.stage,
      createdAt: mskDate(d.created_at), deliveredAt: mskDate(d.delivered_at), amount: Math.round(Number(d.amount ?? 0)),
      group: d.grp, manager: d.manager, products: productsLine(d.products),
      groups: dealGroups(d.grp, d.products),
      state: d.delivered_at ? 'shipped' as const
        : (d.stage_id && LOST_STAGES.includes(d.stage_id)) || /LOSE|APOLOGY/i.test(d.stage_type ?? '') ? 'lost' as const : 'open' as const,
    })),
    calls: rows.map(r => ({
      id: r.id, calledAt: new Date(r.called_at).toISOString(), dealId: Number(r.deal_id), direction: r.direction,
      durationSec: r.dur, stage: r.stage, manager: r.manager, text: r.txt!, hasRoles: r.roles,
    })),
    callsTotal: totals.rows[0]?.total ?? 0,
    callsCompleted: totals.rows[0]?.completed ?? 0,
    callsTrimmed: (totals.rows[0]?.texts_old ?? 0) + trimmedByCap,
    facts,
  };
}

export interface CallListItem {
  id: string; calledAt: string; dealId: number; direction: string | null; result: string | null;
  durationSec: number | null; manager: string | null; hasText: boolean; textChars: number; text?: string; hasRoles?: boolean;
}

/** Все звонки склеенного заказчика для вкладки: без текста — список, с текстом — для просмотра. */
export async function listClientCalls(ref: ClientRef, withText: boolean): Promise<CallListItem[]> {
  const db = analyticsDb();
  const keys = await clientKeys(ref);
  const r = await db.query<{ id: string; called_at: Date; deal_id: number; direction: string | null; result: string | null; dur: number | null; manager: string | null; txt: string | null; len: number | null; roles: boolean | null }>(
    `SELECT c.id::text, c.called_at, c.deal_id, c.direction::text, c.result::text, c.duration_seconds AS dur, coalesce(org.manager_name, e.full_name) AS manager,
            ${withText ? 'coalesce(t.formatted_dialogue, t.raw_text)' : 'NULL::text'} AS txt,
            length(coalesce(t.formatted_dialogue, t.raw_text))::int AS len,
            (t.formatted_dialogue IS NOT NULL) AS roles
       FROM va.calls c
       LEFT JOIN va.transcriptions t ON t.call_id = c.id
       LEFT JOIN sa.employees e ON e.bitrix_id = c.manager_id
       LEFT JOIN sa.org_resolved_hierarchy org ON org.manager_bitrix_user_id = c.manager_id::text
      WHERE c.failed_at_stage IS NULL AND c.deal_id IN (SELECT d.deal_id FROM sa.deals d WHERE d.funnel_id IN (0,1,2,3) AND (${CLIENT_KEY_SQL}) = ANY($1::text[]))
      ORDER BY c.called_at DESC`,
    [keys],
  );
  return r.rows.map(x => {
    // «null» строкой — битая расшифровка (встречается в va.transcriptions), за текст не считаем.
    const has = (x.len ?? 0) > 10;
    return {
      id: x.id, calledAt: new Date(x.called_at).toISOString(), dealId: Number(x.deal_id), direction: x.direction, result: x.result,
      durationSec: x.dur, manager: x.manager, hasText: has, textChars: has ? x.len! : 0,
      ...(withText && has ? { text: x.txt!, hasRoles: !!x.roles } : {}),
    };
  });
}

/** Не товарные группы — в связки не идут (тот же список, что у «Что предложить», potentialGroups.ts). */
export const NON_GOODS = /^(разное|перевозка|доставка|услуг|для логистов|аренда спецтехники|вывоз грунта)/i;

function dealGroups(head: string | null, products: unknown): string[] {
  const out = new Set<string>();
  if (head && !NON_GOODS.test(head)) out.add(head);
  if (Array.isArray(products)) for (const p of products as Record<string, unknown>[]) {
    const g = typeof p.head_group_name === 'string' ? p.head_group_name.trim() : '';
    if (g && !NON_GOODS.test(g)) out.add(g);
  }
  return [...out];
}

function productsLine(products: unknown): string {
  if (!Array.isArray(products)) return '';
  return products.map((p: Record<string, unknown>) => {
    const name = String(p.name ?? p.product_name ?? '').trim();
    const qty = p.quantity ? ` ×${p.quantity}` : '';
    const sum = p.sum ? ` =${Math.round(Number(p.sum))}` : '';
    return `${name}${qty}${sum}`;
  }).filter(Boolean).join('; ').slice(0, 600);
}

/** Факты, которые модель не должна «додумывать»: отказы повторных сделок против реальных звонков. */
async function crmFacts(deals: { deal_id: number; stage_id: string | null; created_at: Date | null; stage: string | null }[], dealIds: number[]): Promise<string[]> {
  const lost = deals.filter(d => d.stage_id && LOST_STAGES.includes(d.stage_id));
  if (!lost.length) return ['Закрытых в отказ повторных сделок нет.'];
  const res = await analyticsDb().query<{ deal_id: number; on_deal: number; talks_on_deal: number; talks_after: number; last_talk: Date | null }>(
    `SELECT d.deal_id,
            (SELECT count(*)::int FROM va.calls x WHERE x.failed_at_stage IS NULL AND x.deal_id = d.deal_id) AS on_deal,
            (SELECT count(*)::int FROM va.calls x WHERE x.failed_at_stage IS NULL AND x.deal_id = d.deal_id AND x.result = 'completed') AS talks_on_deal,
            (SELECT count(*)::int FROM va.calls x WHERE x.failed_at_stage IS NULL AND x.deal_id = ANY($2::bigint[]) AND x.result = 'completed' AND x.called_at >= d.created_at) AS talks_after,
            (SELECT max(x.called_at) FROM va.calls x WHERE x.failed_at_stage IS NULL AND x.deal_id = ANY($2::bigint[]) AND x.result = 'completed') AS last_talk
       FROM sa.deals d WHERE d.deal_id = ANY($1::bigint[])`,
    [lost.map(d => d.deal_id), dealIds],
  );
  const byId = new Map(res.rows.map(r => [Number(r.deal_id), r]));
  return lost.map(d => {
    const r = byId.get(Number(d.deal_id));
    const base = `Повторная сделка #${d.deal_id} закрыта в «${d.stage ?? d.stage_id}»: создана ${mskDate(d.created_at)}, звонков по этой сделке ${r?.on_deal ?? 0} (состоявшихся ${r?.talks_on_deal ?? 0}); состоявшихся разговоров с заказчиком после её создания — ${r?.talks_after ?? 0}; последний разговор — ${mskDate(r?.last_talk ?? null) ?? 'нет'}.`;
    return (r?.talks_after ?? 0) === 0 ? `${base} ⚠ После создания сделки разговоров не было — отказ звонками не подтверждён.` : base;
  });
}
