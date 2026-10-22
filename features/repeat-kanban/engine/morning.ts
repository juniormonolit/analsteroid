// Утреннее сообщение менеджеру по повторным (миграция 238, владелец 22.10). Бот «Аналитик» простыми
// словами, без «окна» и прочих терминов канбана: кто недавно получил отгрузку — самое время позвонить;
// кто сам звонил после отказа; сколько задач по повторным на сегодня. Функция repeat_morning по
// умолчанию ВЫКЛЮЧЕНА — сообщения всё равно собираются и пишутся в repeat_morning_log (сухой прогон),
// чтобы потом сверить: кому из названных позвонили, кому РОП поставил задачу.
import { systemDb } from '@/lib/db/clients';
import { channelEnabled, getBotFunctionConfig, sendBitrixBotMessage } from '@/lib/bitrix/notify';
import { scopeManagers } from '@/features/rop-kanban/engine/kanban';
import { buildRepeatBoard, type KanbanCard } from './board';
import { COLUMNS, type ColumnKey } from './config';
import { queueScore } from './queue';

const ORIGIN = (process.env.APP_BASE_URL || 'https://monolitika.mlt-it.com').replace(/\/$/, '');
const TOP = 5;

export interface MorningItem { key: string; name: string; kind: 'fresh' | 'returned' | 'task'; lastDeliveredAt?: string | null; taskId?: number }
export interface MorningMessage { managerId: string; managerName: string; message: string; items: MorningItem[] }

const plural = (n: number, one: string, few: string, many: string) => {
  const m10 = n % 10, m100 = n % 100;
  return m10 === 1 && m100 !== 11 ? one : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? few : many;
};
const ddmm = (iso: string) => new Date(iso).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', timeZone: 'Europe/Moscow' });
const mskYmd = (ms = Date.now()) => new Date(ms + 3 * 3600_000).toISOString().slice(0, 10);
const nameOf = (c: KanbanCard) => c.name ?? `${c.clientType === 'company' ? 'Компания' : 'Контакт'} #${c.clientId}`;
const firstName = (full: string) => full.trim().split(/\s+/)[0] || full;
const daysAgo = (iso: string) => Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000));

// Немного разных зачинов, чтобы утро не читалось как один и тот же шаблон (выбор — по дате).
const OPENERS = [
  'эти заказчики недавно получили у тебя отгрузку — самое время позвонить. Спроси, как всё приехало и что ещё понадобится на объекте:',
  'у этих заказчиков недавно была отгрузка — сейчас лучший момент напомнить о себе: узнать, всё ли в порядке и что нужно дальше:',
  'недавно отгружались у тебя — позвони, пока стройка идёт и материал ещё понадобится:',
];

/** Собрать сообщение одного менеджера по его карточкам доски; null — сказать нечего. */
export function composeMorning(managerId: string, managerName: string, cards: KanbanCard[], dateStr: string): MorningMessage | null {
  const todayEnd = new Date(`${dateStr}T23:59:59+03:00`).getTime();
  const openTask = (c: KanbanCard) => c.task && c.task.state !== 'done' && c.task.state !== 'control';
  const returned = cards.filter(c => c.returned && c.column.startsWith('pool') && !openTask(c));
  const fresh = cards
    .filter(c => c.column === 'pool_hot' && !c.returned && !openTask(c) && !c.queued && c.lastDeliveredAt)
    .sort((a, b) => queueScore(b, 0) - queueScore(a, 0));
  const tasks = cards.filter(c => openTask(c) && c.task!.responsibleId === managerId && c.task!.deadlineAt && new Date(c.task!.deadlineAt).getTime() <= todayEnd);
  const overdue = tasks.filter(c => new Date(c.task!.deadlineAt!).getTime() < Date.now()).length;
  if (!fresh.length && !returned.length && !tasks.length) return null;

  const items: MorningItem[] = [];
  const lines: string[] = [];
  const opener = OPENERS[Number(dateStr.slice(8, 10)) % OPENERS.length];
  lines.push(`Доброе утро, ${firstName(managerName)}!`);
  if (fresh.length) {
    lines.push('', `[B]Кому позвонить:[/B] ${opener}`);
    fresh.slice(0, TOP).forEach((c, i) => {
      const d = daysAgo(c.lastDeliveredAt!);
      lines.push(`${i + 1}. ${nameOf(c)} — отгрузка ${d === 0 ? 'сегодня' : `${d} ${plural(d, 'день', 'дня', 'дней')} назад`}${c.lastDeliveredGroup ? `, ${c.lastDeliveredGroup.toLowerCase()}` : ''}`);
      items.push({ key: c.clientKey, name: nameOf(c), kind: 'fresh', lastDeliveredAt: c.lastDeliveredAt });
    });
    if (fresh.length > TOP) lines.push(`И ещё ${fresh.length - TOP} — в канбане повторных, колонка «Срочно».`);
  }
  if (returned.length) {
    lines.push('', '[B]Звонили тебе сами:[/B] раньше отказались, а теперь звонили — перезвони сегодня:');
    for (const c of returned.slice(0, TOP)) {
      lines.push(`• ${nameOf(c)} — ${c.returned!.missed ? 'пропущенный звонок' : 'звонил'} ${ddmm(c.returned!.at)}`);
      items.push({ key: c.clientKey, name: nameOf(c), kind: 'returned' });
    }
    if (returned.length > TOP) lines.push(`И ещё ${returned.length - TOP}.`);
  }
  if (tasks.length) {
    lines.push('', `[B]Задачи по повторным на сегодня:[/B] ${tasks.length}${overdue ? `, из них просрочено ${overdue}` : ''}.`);
    for (const c of tasks) items.push({ key: c.clientKey, name: nameOf(c), kind: 'task', taskId: c.task!.id });
  }
  lines.push('', `[URL=${ORIGIN}/repeat-kanban]Открыть канбан повторных[/URL]`);
  return { managerId, managerName, message: lines.join('\n'), items };
}

/** Сообщения всем менеджерам компании (одна сборка доски на всех, ~5 с). */
export async function buildMorningMessages(dateStr = mskYmd()): Promise<MorningMessage[]> {
  const managers = await scopeManagers({ full: true, allowedDeptIds: null, selfOnly: null });
  // Нужны «Срочно» (свежие отгрузки, «вернулся сам») и колонки работы (задачи на сегодня); остальной пул — нет.
  const want = (k: ColumnKey) => k === 'pool_hot' || k.startsWith('touch') || k.startsWith('st_') || k === 'review';
  const limits = Object.fromEntries(COLUMNS.map(c => [c.key, want(c.key) ? 2000 : 0])) as Partial<Record<ColumnKey, number>>;
  const board = await buildRepeatBoard({ managers, selectedManagers: [], typeFilter: null, canManage: false, limits });
  const byMgr = new Map<string, KanbanCard[]>();
  for (const col of board.columns) for (const c of col.cards) {
    const l = byMgr.get(c.managerId) ?? [];
    l.push(c); byMgr.set(c.managerId, l);
  }
  const out: MorningMessage[] = [];
  for (const m of managers) {
    const msg = composeMorning(m.id, m.name, byMgr.get(m.id) ?? [], dateStr);
    if (msg) out.push(msg);
  }
  return out;
}

/** Утренний прогон: собрать, записать в журнал, отправить — только если функция включена (и, если
 *  задан пилотный список получателей, только им). Повторный прогон за ту же дату ничего не дублирует. */
export async function runRepeatMorning(dateStr = mskYmd()): Promise<{ built: number; logged: number; sent: number; failed: number; dryRun: boolean }> {
  const db = systemDb();
  const msgs = await buildMorningMessages(dateStr);
  const enabled = await channelEnabled('repeat_morning');
  const pilot = new Set((await getBotFunctionConfig('repeat_morning')).recipients ?? []);
  let logged = 0, sent = 0, failed = 0;
  for (const m of msgs) {
    const ins = await db.query<{ id: string }>(
      `INSERT INTO repeat_morning_log (run_date, manager_id, manager_name, message, items, client_keys)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6::text[]) ON CONFLICT (run_date, manager_id) DO NOTHING RETURNING id::text`,
      [dateStr, m.managerId, m.managerName, m.message, JSON.stringify(m.items), [...new Set(m.items.map(i => i.key))]],
    );
    if (!ins.rows[0]) continue;
    logged++;
    if (!enabled || (pilot.size && !pilot.has(m.managerId))) continue;
    try {
      const id = await sendBitrixBotMessage(m.managerId, m.message, undefined, 'repeat_morning');
      await db.query('UPDATE repeat_morning_log SET sent = true, message_id = $2 WHERE id = $1', [ins.rows[0].id, id || null]);
      sent++;
    } catch (e) {
      failed++;
      await db.query('UPDATE repeat_morning_log SET error = $2 WHERE id = $1', [ins.rows[0].id, (e instanceof Error ? e.message : String(e)).slice(0, 500)]);
    }
  }
  return { built: msgs.length, logged, sent, failed, dryRun: !enabled };
}
