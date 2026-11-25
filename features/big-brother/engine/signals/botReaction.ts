// «Большой брат», поток G — реакция на бота: сообщение ушло → через сколько человек открыл Монолитику → через сколько
// сделал действие или пошёл рабочий сигнал (звонок, стадия, задача, мутация в сервисе).
//
// Журнал отправок `bot_message_log` (миграция 297 потока A; берём status = 'sent') и метки `?src=bot&m=<id>` в ссылках
// (трекер кладёт их в payload.query первого mono_view). Пока таблицы нет (42P01) —
// available = false, UI пишет «копится с …». Колонки читаются по information_schema (имена у потока A ещё могут
// поменяться): время — sent_at | created_at | ts, получатель — recipient_bitrix_id | bitrix_user_id | dialog_id |
// to_bitrix_id, функция — channel | function_key | key.
// «Открыл»: первое событие Монолитики (mono_view / session / активный бакет) в 24 ч после отправки; по ссылке — если в
// payload события m = id сообщения (payload.query.m; запасные — payload.m / ?m= в payload.path).
// «Действие»: первое mono_action / kanban / logist или рабочий сигнал (исходящий звонок, принятый входящий, смена
// стадии, поставил / закрыл задачу) — те же источники, что дневной агрегат (../daily/sources.ts).
import { systemDb } from '@/lib/db/clients';
import { loadSourceEvents } from '../daily/sources';
import type { BotReactionRow, BotReactionSummary } from './types';

const WINDOW_MS = 24 * 3600_000;
const pick = (cols: Set<string>, names: string[]) => names.find(n => cols.has(n)) ?? null;

function median(l: number[]): number | null {
  if (!l.length) return null;
  const s = [...l].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
}

const EMPTY: BotReactionSummary = {
  since: null, available: false, total: 0, opened: 0, acted: 0, silent: 0, medianOpenMin: null, medianActMin: null, byChannel: [], recent: [],
};

/** Реакция на сообщения бота за последние `days` дней людям allowIds (null — всем). */
export async function loadBotReaction(o: { allowIds: Set<string> | null; names: Map<string, string>; days?: number; now?: number }): Promise<BotReactionSummary> {
  const db = systemDb();
  const now = o.now ?? Date.now();
  const colsR = await db.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns WHERE table_name = 'bot_message_log' AND table_schema = current_schema()`,
  ).catch(() => ({ rows: [] as { column_name: string }[] }));
  const cols = new Set(colsR.rows.map(r => r.column_name));
  const tCol = pick(cols, ['sent_at', 'created_at', 'ts']);
  const rCol = pick(cols, ['recipient_bitrix_id', 'bitrix_user_id', 'dialog_id', 'to_bitrix_id']);
  if (!cols.size || !tCol || !rCol || !cols.has('id')) return EMPTY;
  const cCol = pick(cols, ['channel', 'function_key', 'key']);

  const sinceR = await db.query<{ t: Date | null }>(`SELECT min(${tCol}) AS t FROM bot_message_log`).catch(() => null);
  if (!sinceR) return EMPTY;
  const since = sinceR.rows[0]?.t ? new Date(sinceR.rows[0].t).toISOString() : null;
  const from = new Date(now - (o.days ?? 30) * 86_400_000);
  const msgs = (await db.query<{ id: string; t: Date; rid: string; ch: string | null }>(
    `SELECT id::text AS id, ${tCol} AS t, ${rCol}::text AS rid, ${cCol ? `${cCol}::text` : 'NULL'} AS ch
       FROM bot_message_log WHERE ${tCol} >= $1 ${cols.has('status') ? `AND status = 'sent'` : ''} ORDER BY ${tCol} DESC LIMIT 3000`, [from.toISOString()],
  )).rows.filter(m => /^\d+$/.test(m.rid) && (!o.allowIds || o.allowIds.has(m.rid)));
  if (!msgs.length) return { ...EMPTY, available: true, since };

  const ids = [...new Set(msgs.map(m => m.rid))];
  const [src, opens] = await Promise.all([
    loadSourceEvents(ids, from, new Date(Math.min(now, Date.now()) + 60_000)),
    db.query<{ id: string; t: Date; m: string | null }>(
      `SELECT bitrix_user_id AS id, ts AS t,
              COALESCE(payload->'query'->>'m', payload->>'m', payload->>'msg', substring(coalesce(payload->>'path', '') || '&' || coalesce(payload->>'query', '') from '[?&]m=([0-9]+)')) AS m
         FROM activity_events WHERE bitrix_user_id = ANY($1) AND ts >= $2 AND kind IN ('mono_view', 'session')`,
      [ids, from.toISOString()],
    ).catch(() => ({ rows: [] as { id: string; t: Date; m: string | null }[] })),
  ]);
  const evBy = new Map<string, { at: number; kind: string; open: boolean; act: boolean; m: string | null }[]>();
  const push = (id: string, x: { at: number; kind: string; open: boolean; act: boolean; m: string | null }) => {
    const l = evBy.get(id); if (l) l.push(x); else evBy.set(id, [x]);
  };
  for (const e of src.events) {
    if (e.weak) continue;
    const act = e.kind === 'mono_action' || e.kind === 'kanban' || e.kind === 'logist' || e.kind === 'deal_stage'
      || (e.kind === 'call' && e.action !== 'in_missed') || (e.kind === 'task' && (e.action === 'create' || e.action === 'close'));
    const open = e.kind === 'mono_view' || e.kind === 'session' || e.kind === 'mono_action';
    if (act || open) push(e.mid, { at: e.at, kind: e.kind === 'call' ? 'звонок' : e.kind === 'deal_stage' ? 'стадия' : e.kind === 'task' ? 'задача' : 'Монолитика', open, act, m: null });
  }
  for (const b of src.monoBuckets) push(b.mid, { at: b.at, kind: 'Монолитика', open: true, act: false, m: null });
  for (const r of opens.rows) push(r.id, { at: new Date(r.t).getTime(), kind: 'Монолитика', open: true, act: false, m: r.m });
  for (const l of evBy.values()) l.sort((a, b) => a.at - b.at);

  const rows: BotReactionRow[] = msgs.map(m => {
    const t = new Date(m.t).getTime();
    const l = (evBy.get(m.rid) ?? []).filter(e => e.at >= t - 60_000 && e.at <= t + WINDOW_MS);
    const byLink = l.find(e => e.m === m.id);
    const open = byLink ?? l.find(e => e.open);
    const act = l.find(e => e.act);
    const mins = (x: number) => Math.max(0, Math.round((x - t) / 60_000));
    return {
      messageId: m.id, sentAt: new Date(m.t).toISOString(), recipientId: m.rid, recipientName: o.names.get(m.rid) ?? null,
      channel: m.ch, openMin: open ? mins(open.at) : null, openedByLink: !!byLink, actMin: act ? mins(act.at) : null, actKind: act?.kind ?? null,
    };
  });
  // Сообщения младше 24 ч ещё «зреют» — в доли и медианы не берём.
  const ripe = rows.filter(r => now - Date.parse(r.sentAt) >= WINDOW_MS);
  const chMap = new Map<string, BotReactionRow[]>();
  for (const r of ripe) { const k = r.channel ?? '—'; const l = chMap.get(k); if (l) l.push(r); else chMap.set(k, [r]); }
  return {
    since, available: true, total: ripe.length,
    opened: ripe.filter(r => r.openMin != null).length, acted: ripe.filter(r => r.actMin != null).length,
    silent: ripe.filter(r => r.openMin == null && r.actMin == null).length,
    medianOpenMin: median(ripe.flatMap(r => (r.openMin != null ? [r.openMin] : []))),
    medianActMin: median(ripe.flatMap(r => (r.actMin != null ? [r.actMin] : []))),
    byChannel: [...chMap].map(([channel, l]) => ({
      channel, total: l.length, opened: l.filter(r => r.openMin != null).length, acted: l.filter(r => r.actMin != null).length,
      medianActMin: median(l.flatMap(r => (r.actMin != null ? [r.actMin] : []))),
    })).sort((a, b) => b.total - a.total),
    recent: rows.slice(0, 50),
  };
}
