// S5: уведомления канбана запросов логистам ботом «Аналитик» (LOGIST_REQUESTS_SPEC.md, «Уведомления»).
//
// Кому что (решение владельца 17–19.11):
//   логистам очереди — новый запрос (отправлен / передан в очередь / возвращён без держателя) и «горит SLA» по не взятому;
//   держателю       — возврат на доработку, сообщение в чате, назначение, «горит SLA» по взятому, приём / отмена;
//   менеджеру       — ответ логиста (вариант), сообщение в чате;
//   РОПу менеджера  — просрочка SLA (раз на цикл).
// Робот стадии (S2, trigger.ts) уже шлёт менеджеру «запрос ушёл / дополни черновик» — здесь это не дублируется.
//
// Все сообщения — через sendManagerBotMessage (единая точка: общий dry-run, журнал bot_outbound_log с ID и следом
// решения). Функции бота: менеджеру — logist_requests (миграция 271, msgType 'logist_request_*'); логистам и РОПам —
// logist_requests_staff (миграция 272, msgType 'logist_staff_*'). Обе выключены, пока владелец не включит.
//
// «Логисты очереди» = участники проекта Битрикса, среди которых CEO/COO/РОПы/разработчики — рассылку режет фильтр
// получателей (настройки канбана, recipients.ts): по умолчанию должность содержит «логист» или «снабж», плюс ручные
// «включить / исключить». Видимость и «Взять» фильтр не трогает.
//
// Повторы: журнал logist_request_notifications (миграция 272). «Горит SLA» / «просрочка» — раз на цикл и получателя
// (уникальный индекс, сначала «захват» строкой, потом отправка); сообщения чата — не чаще раза в 15 минут.
// Ошибки не бросает: уведомление — после коммита, действие пользователя от него не зависит.
import { analyticsDb, systemDb } from '@/lib/db/clients';
import { sendManagerBotMessage } from '@/features/badges/engine/notifications';
import { REQUEST_TYPE_LABEL, type RequestCard, type RequestDetails } from './contract';
import type { LogistHookCtx } from './hooks';
import { toCard, type RequestRow } from './mapper';
import { loadQueues } from './queues';
import { queueRecipients, recipientVerdict } from './recipients';
import { CARD_SELECT, loadSettings, queueMap } from './repo';
import { workHoursBetween } from './worktime';

const ORIGIN = () => (process.env.APP_BASE_URL || 'https://monolitika.mlt-it.ru').replace(/\/$/, '');
/** Логисту — карточка на доске; менеджеру (у него нет раздела «Канбан логиста») — «Мои запросы» в ЛК. */
export const logistLink = (id: number) => `${ORIGIN()}/logist-kanban?req=${id}`;
export const managerLink = (id: number) => `${ORIGIN()}/profile/logist-requests?req=${id}`;

const CHAT_THROTTLE_MIN = 15;

type Kind = 'new' | 'hot' | 'overdue_rop' | 'answered' | 'returned' | 'message' | 'reassigned' | 'transferred' | 'accepted' | 'cancelled';

const money = (x: number) => `${Math.round(x).toLocaleString('ru-RU')} ₽`;
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const bb = (s: string) => s.replace(/\[/g, '(').replace(/\]/g, ')');

function about(r: Pick<RequestCard, 'id' | 'type' | 'client' | 'deal' | 'itemsPreview' | 'amount'>): string {
  const who = r.client.name ?? r.deal?.title ?? null;
  const parts = [`«${REQUEST_TYPE_LABEL[r.type]}»`, who ? bb(who) : null, r.itemsPreview ? bb(clip(r.itemsPreview, 120)) : null,
    r.amount > 0 ? money(r.amount) : null].filter(Boolean);
  return parts.join(' · ');
}
const link = (url: string, text = 'Открыть запрос') => `[URL=${url}]${text}[/URL]`;

async function claim(requestId: number, kind: Kind, cycle: number, to: string): Promise<boolean> {
  if (kind === 'hot' || kind === 'overdue_rop') {
    const r = await systemDb().query(
      `INSERT INTO logist_request_notifications (request_id, kind, cycle, recipient_bitrix_id) VALUES ($1,$2,$3,$4)
       ON CONFLICT (request_id, kind, cycle, recipient_bitrix_id) WHERE kind IN ('hot', 'overdue_rop') DO NOTHING RETURNING id`,
      [requestId, kind, cycle, to]);
    return !!r.rowCount;
  }
  if (kind === 'message') {
    const recent = await systemDb().query(
      `SELECT 1 FROM logist_request_notifications WHERE request_id = $1 AND recipient_bitrix_id = $2 AND kind = 'message'
         AND sent_at > now() - make_interval(mins => $3) LIMIT 1`, [requestId, to, CHAT_THROTTLE_MIN]);
    if (recent.rowCount) return false;
  }
  await systemDb().query(`INSERT INTO logist_request_notifications (request_id, kind, cycle, recipient_bitrix_id) VALUES ($1,$2,$3,$4)`,
    [requestId, kind, cycle, to]);
  return true;
}

interface Out { to: string; kind: Kind; text: string; staff: boolean; trace?: unknown }

async function deliver(r: { id: number; cycle: number }, outs: Out[]): Promise<number> {
  let n = 0;
  for (const o of outs) {
    if (!/^\d+$/.test(o.to)) continue;
    try {
      if (!(await claim(r.id, o.kind, r.cycle, o.to))) continue;
      await sendManagerBotMessage(Number(o.to), o.text, `${o.staff ? 'logist_staff' : 'logist_request'}_${o.kind}`,
        `logist_request:${r.id}:${o.kind}`, { decisionTrace: { requestId: r.id, kind: o.kind, cycle: r.cycle, ...(o.trace ? { why: o.trace } : {}) } });
      n++;
    } catch (e) {
      // нет таблицы (миграция 272 не накатилась) — молчим, это не повод ронять действие
      if ((e as { code?: string }).code !== '42P01') console.warn('[logist-notify]', r.id, o.kind, o.to, e instanceof Error ? e.message : e);
    }
  }
  return n;
}

/** Логисты очереди, прошедшие фильтр получателей (без автора действия). */
async function queueTargets(queueId: number | null, exceptId: string | null): Promise<{ ids: string[]; trace: unknown }> {
  if (!queueId) return { ids: [], trace: 'нет очереди' };
  const [queues, settings] = await Promise.all([loadQueues(), loadSettings()]);
  const q = queues.find(x => x.id === queueId);
  if (!q || !q.active) return { ids: [], trace: 'очередь выключена' };
  const ids = queueRecipients(q.members, settings.notify, exceptId);
  return {
    ids,
    trace: { queue: q.name, members: q.members.map(m => ({ id: m.bitrixId, position: m.workPosition, verdict: recipientVerdict(m, settings.notify) })) },
  };
}

/** Хук после действия (hooks.ts afterLogistChange). */
export async function notifyForChange(ctx: LogistHookCtx): Promise<void> {
  const r: RequestDetails = ctx.request;
  const actor = ctx.actor.bitrixId;
  const head = about(r);
  const outs: Out[] = [];
  const toLogistQueue = async (kind: Kind, title: string) => {
    const t = await queueTargets(r.queue?.id ?? null, actor);
    for (const id of t.ids) outs.push({ to: id, kind, staff: true, trace: t.trace,
      text: `[B]${title} №${r.id}[/B]\n${head}\nОчередь: ${bb(r.queue?.name ?? '—')} · менеджер ${bb(r.manager.name ?? '')}\n${link(logistLink(r.id), 'Открыть и взять')}` });
  };
  const holder = r.logist?.bitrixId && r.logist.bitrixId !== actor ? r.logist.bitrixId : null;
  const toManager = r.manager.bitrixId !== actor ? r.manager.bitrixId : null;
  const lastEvent = (kind: string) => [...r.events].reverse().find(e => e.kind === kind);

  switch (ctx.action) {
    case 'send':
      if (r.status === 'new') await toLogistQueue('new', 'Новый запрос логисту');
      break;
    case 'transfer':
      if (r.status === 'new') await toLogistQueue('transferred', 'Запрос передан в вашу очередь');
      break;
    case 'return': {
      const comment = String(lastEvent('returned')?.data.comment ?? '');
      const body = `${head}${comment ? `\nМенеджер: «${bb(clip(comment, 400))}»` : ''}`;
      if (r.status === 'new') await toLogistQueue('returned', 'Запрос вернули на доработку');
      else if (holder) outs.push({ to: holder, kind: 'returned', staff: true,
        text: `[B]Запрос №${r.id} вернули на доработку[/B]\n${body}\n${link(logistLink(r.id))}` });
      break;
    }
    case 'answer':
      if (toManager) {
        const o = r.offers.filter(x => x.status === 'active').sort((a, b) => b.n - a.n)[0];
        outs.push({ to: toManager, kind: 'answered', staff: false,
          text: `[B]Логист ответил на запрос №${r.id}[/B]\n${head}\n${o ? `Вариант ${o.n}${o.supplier ? ` · ${bb(o.supplier)}` : ''} · итого ${money(o.total)}${o.leadTime ? ` · срок ${bb(o.leadTime)}` : ''}\n` : ''}`
            + `Прими вариант или верни на доработку — ${link(managerLink(r.id), 'открыть запрос')}` });
      }
      break;
    case 'reassign':
      if (holder) outs.push({ to: holder, kind: 'reassigned', staff: true,
        text: `[B]Вам назначили запрос №${r.id}[/B]\n${head}\nНазначил: ${bb(ctx.actor.name)}\n${link(logistLink(r.id))}` });
      break;
    case 'accept':
      if (holder) outs.push({ to: holder, kind: 'accepted', staff: true,
        text: `[B]Менеджер принял ваш вариант по запросу №${r.id}[/B]\n${head}\n${link(logistLink(r.id))}` });
      break;
    case 'cancel':
      if (holder) {
        const reason = String(lastEvent('cancelled')?.data.reason ?? '');
        outs.push({ to: holder, kind: 'cancelled', staff: true,
          text: `[B]Запрос №${r.id} отменён[/B]\n${head}${reason ? `\nПричина: «${bb(clip(reason, 300))}»` : ''}\nМожно не искать дальше.` });
      }
      break;
    case 'message': {
      const m = r.messages.find(x => x.id === ctx.messageId);
      const snippet = m ? `\n${bb(ctx.actor.name)}: «${bb(clip(m.body, 300))}»` : '';
      if (toManager) outs.push({ to: toManager, kind: 'message', staff: false,
        text: `[B]Новое сообщение по запросу логисту №${r.id}[/B]\n${head}${snippet}\n${link(managerLink(r.id), 'Ответить')}` });
      if (holder && holder !== toManager) outs.push({ to: holder, kind: 'message', staff: true,
        text: `[B]Новое сообщение по запросу №${r.id}[/B]\n${head}${snippet}\n${link(logistLink(r.id), 'Ответить')}` });
      break;
    }
    default:
      break;
  }
  if (outs.length) await deliver({ id: r.id, cycle: r.cycle }, outs);
}

// ── фоновая проверка SLA ──────────────────────────────────────────────────────────────

/** Сейчас рабочее время (будни 9–18 МСК без праздников) — ночью и в выходные не будим. */
export const isWorkTimeNow = (now: Date) => workHoursBetween(new Date(now.getTime() - 60_000), now) > 0;

async function ropOf(managerId: string): Promise<string | null> {
  const r = await analyticsDb().query<{ rop: string | null }>(
    `SELECT rop_bitrix_user_id AS rop FROM sa.org_resolved_hierarchy WHERE manager_bitrix_user_id = $1 LIMIT 1`, [managerId]);
  return r.rows[0]?.rop ?? null;
}

/** «Горит SLA» — логистам (не взят — очереди, взят — держателю), «просрочен» — РОПу менеджера. Раз на цикл. */
export async function sweepSla(now = new Date()): Promise<{ checked: number; hot: number; overdue: number; sent: number }> {
  if (!isWorkTimeNow(now)) return { checked: 0, hot: 0, overdue: 0, sent: 0 };
  const [settings, queues] = await Promise.all([loadSettings(), loadQueues()]);
  const r = await systemDb().query<RequestRow>(`${CARD_SELECT} WHERE r.status IN ('new','in_work') ORDER BY r.id`, ['']);
  const ctx = { queues: queueMap(queues), settings, now };
  const cards = r.rows.map(x => toCard(x, ctx));
  const byQueue = new Map(queues.map(q => [q.id, q]));
  let hot = 0, overdue = 0, sent = 0;
  const ropCache = new Map<string, string | null>();
  for (const c of cards) {
    if (c.sla.state !== 'hot' && c.sla.state !== 'overdue') continue;
    const outs: Out[] = [];
    const head = about(c);
    const left = c.sla.leftHours ?? 0;
    // «горит» шлём и тем, у кого запрос сразу ушёл в просрочку (тик пропустил «горит»)
    const hotText = (forHolder: boolean) => `[B]🔥 Горит SLA по запросу №${c.id}[/B]\n${head}\n`
      + (c.sla.state === 'overdue' ? `SLA уже просрочен на ${Math.abs(left).toLocaleString('ru-RU')} раб. ч` : `До конца SLA ${Math.max(0, left).toLocaleString('ru-RU')} раб. ч`)
      + `${forHolder ? '' : ' — запрос никто не взял'}\n${link(logistLink(c.id), forHolder ? 'Открыть запрос' : 'Открыть и взять')}`;
    if (c.logist) outs.push({ to: c.logist.bitrixId, kind: 'hot', staff: true, text: hotText(true) });
    else {
      const q = c.queue ? byQueue.get(c.queue.id) : undefined;
      if (q?.active) for (const id of queueRecipients(q.members, settings.notify)) outs.push({ to: id, kind: 'hot', staff: true, text: hotText(false) });
    }
    hot++;
    if (c.sla.state === 'overdue') {
      overdue++;
      let rop = ropCache.get(c.manager.bitrixId);
      if (rop === undefined) { rop = await ropOf(c.manager.bitrixId).catch(() => null); ropCache.set(c.manager.bitrixId, rop); }
      if (rop && rop !== c.manager.bitrixId) outs.push({ to: rop, kind: 'overdue_rop', staff: true,
        text: `[B]Просрочен SLA по запросу логисту №${c.id}[/B]\n${head}\nМенеджер ${bb(c.manager.name ?? '')} · `
          + `${c.logist ? `логист ${bb(c.logist.name ?? '')}` : 'никто не взял'} · очередь ${bb(c.queue?.name ?? '—')}\n`
          + `Просрочка ${Math.abs(left).toLocaleString('ru-RU')} раб. ч (норма ${c.sla.hours} ч)\n${link(logistLink(c.id))}` });
    }
    sent += await deliver({ id: c.id, cycle: c.cycle }, outs);
  }
  return { checked: cards.length, hot, overdue, sent };
}
