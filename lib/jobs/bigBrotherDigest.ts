// «Большой брат», поток G — еженедельный дайджест директору ботом «Аналитик» (понедельник утром, функция
// big_brother_digest, настройки — вкладка «Сигналы»). Только ОТКЛОНЕНИЯ, до 10 строк:
//   кто пропал / перестал заходить (сигналы no_signal / no_mono, появившиеся за неделю),
//   РОПы без задач за неделю (Битрикс created_by + постановки канбана повторки, activity_daily),
//   топ и антитоп отчётов (просмотры + загрузки из activity_daily.sections; антитоп — открывали в прошлые 4 недели,
//   на этой — ни разу), прочие новые сигналы (спад, ночь, выгрузки, новый способ входа).
// Срез — каждому получателю его срез (getSessionScope по его пользователю Монолитики); получатель без доступа к
// «Большому брату» пропускается. Режим preview — уходит только previewTo. Сообщения сотрудникам не шлём никогда.
import { systemDb } from '@/lib/db/clients';
import { loadSessionUserById, type SessionUser } from '@/lib/auth/session';
import { sendBitrixBotMessage, sendBitrixBotMessageWithImage } from '@/lib/bitrix/notify';
import { canViewBigBrother } from '@/lib/activity/access';
import { isReportSection } from '@/lib/activity/section';
import { scopedPeople } from '@/features/big-brother/engine/daily/access';
import type { MonitoredPerson } from '@/features/big-brother/engine/daily/people';
import { addDays, mskDate } from '@/features/big-brother/engine/daily/time';
import { buildSignalFeed } from '@/features/big-brother/engine/signals/load';
import { DIGEST_CHANNEL, loadDigestSettings } from '@/features/big-brother/engine/signals/settings';
import { SIGNAL_LABEL, type SignalKind } from '@/features/big-brother/engine/signals/types';

const ORIGIN = (process.env.APP_BASE_URL || 'https://monolitika.mlt-it.ru').replace(/\/$/, '');
const MAX_LINES = 10;

const REPORT_LABELS: Record<string, string> = {
  'sales/by-managers': 'По менеджерам', 'sales/by-product-groups': 'По товарным группам', 'sales/by-periods': 'По периодам',
  'sales/by-clients': 'По клиентам', 'sales/client-tail': 'Вход и хвост', 'sales/product-matrix': 'Товарная матрица',
  'sales/transition-matrix': 'Матрица переходов', 'sales/repeat': 'Повторные', 'realizations/responses': 'Реализация: ответы',
  'realizations/requests': 'Реализация: заявки', 'realizations/logists': 'Реализация: логисты', 'realizations/regions': 'Реализация: регионы',
};

const names = (l: string[], max = 4) => (l.length > max ? `${l.slice(0, max).join(', ')} (+${l.length - max})` : l.join(', '));
const fmtD = (d: string) => `${d.slice(8, 10)}.${d.slice(5, 7)}`;

/** Неделя дайджеста: прошлые пн–вс относительно now (МСК). */
export function digestWeek(now = Date.now()): { from: string; to: string } {
  const today = mskDate(now);
  const dow = new Date(`${today}T00:00:00Z`).getUTCDay() || 7;
  const to = addDays(today, -dow);       // прошлое воскресенье
  return { from: addDays(to, -6), to };
}

interface WeekRow { id: string; tasks: number; sections: Record<string, { views?: number; report_load?: number }>; }

async function loadWeek(ids: string[], from: string, to: string): Promise<WeekRow[]> {
  const r = await systemDb().query<{ id: string; tasks: number; counts: Record<string, number>; sections: WeekRow['sections'] }>(
    `SELECT bitrix_user_id AS id, tasks_created AS tasks, counts, sections FROM activity_daily
      WHERE bitrix_user_id = ANY($1) AND snap_date BETWEEN $2::date AND $3::date`, [ids, from, to],
  );
  return r.rows.map(x => ({
    id: x.id, sections: x.sections ?? {},
    tasks: x.tasks + (x.counts?.['kanban.deal_task_created'] ?? 0) + (x.counts?.['kanban.task_created'] ?? 0),
  }));
}

async function reportUsage(ids: string[], from: string, to: string): Promise<Map<string, { hits: number; users: Set<string> }>> {
  const m = new Map<string, { hits: number; users: Set<string> }>();
  for (const r of await loadWeek(ids, from, to)) {
    for (const [sec, v] of Object.entries(r.sections)) {
      if (!isReportSection(sec)) continue;
      const hits = (v.views ?? 0) + (v.report_load ?? 0);
      if (!hits) continue;
      const e = m.get(sec) ?? { hits: 0, users: new Set<string>() };
      e.hits += hits; e.users.add(r.id); m.set(sec, e);
    }
  }
  return m;
}

async function reportLabels(secs: string[]): Promise<Map<string, string>> {
  const saved = secs.filter(s => s.startsWith('sales/saved/')).map(s => s.slice(12));
  const r = saved.length
    ? await systemDb().query<{ id: string; name: string }>(`SELECT id::text, name FROM saved_reports WHERE id::text = ANY($1)`, [saved]).catch(() => ({ rows: [] }))
    : { rows: [] as { id: string; name: string }[] };
  const sn = new Map(r.rows.map(x => [`sales/saved/${x.id}`, x.name]));
  return new Map(secs.map(s => [s, sn.get(s) ?? REPORT_LABELS[s] ?? (s.startsWith('marketing/') ? `Маркетинг: ${s.slice(10)}` : s)]));
}

/** Текст дайджеста для людей среза (BB-коды Битрикса). Пустых разделов нет; нечего сказать — короткое «без отклонений». */
export async function buildDigestText(people: MonitoredPerson[], now = Date.now()): Promise<string> {
  const { from, to } = digestWeek(now);
  const ids = people.map(p => p.id);
  const lines: string[] = [];

  const { signals } = await buildSignalFeed(people, to);
  const fresh = signals.filter(s => s.since >= from);
  const gone = fresh.filter(s => s.kind === 'no_signal' || s.kind === 'no_mono');
  if (gone.length) lines.push(`🔕 Перестали выходить на связь / заходить: ${names(gone.map(s => s.name))}`);

  const rops = people.filter(p => p.role === 'rop');
  if (rops.length) {
    // Только по РОПам, у которых агрегат за неделю собран (нет строк — нет данных, а не «нет задач»).
    const tasks = new Map<string, number>();
    for (const r of await loadWeek(rops.map(p => p.id), from, to)) tasks.set(r.id, (tasks.get(r.id) ?? 0) + r.tasks);
    const idle = rops.filter(p => tasks.has(p.id) && !tasks.get(p.id)).map(p => p.name);
    if (idle.length) lines.push(`📋 РОПы без задач подчинённым за неделю: ${names(idle)}`);
  }

  const [week, prior] = await Promise.all([reportUsage(ids, from, to), reportUsage(ids, addDays(from, -28), addDays(from, -1))]);
  const labels = await reportLabels([...new Set([...week.keys(), ...prior.keys()])]);
  const top = [...week].sort((a, b) => b[1].users.size - a[1].users.size || b[1].hits - a[1].hits).slice(0, 3);
  if (top.length) lines.push(`📈 Чаще всего смотрели: ${top.map(([s, v]) => `${labels.get(s)} (${v.users.size} чел.)`).join(', ')}`);
  const dead = [...prior].filter(([s]) => !week.has(s)).sort((a, b) => b[1].users.size - a[1].users.size).map(([s]) => labels.get(s)!);
  if (dead.length) lines.push(`📉 Перестали открывать (были в прошлые 4 недели): ${names(dead, 3)}`);

  const byKind = new Map<SignalKind, string[]>();
  for (const s of fresh) if (s.kind !== 'no_signal' && s.kind !== 'no_mono') byKind.set(s.kind, [...(byKind.get(s.kind) ?? []), s.name]);
  for (const [k, l] of [...byKind].sort((a, b) => b[1].length - a[1].length)) {
    if (lines.length >= MAX_LINES) break;
    lines.push(`⚠️ ${SIGNAL_LABEL[k]}: ${names(l, 3)}`);
  }

  const head = `[B]Большой брат: неделя ${fmtD(from)}–${fmtD(to)}[/B]`;
  const link = `[URL=${ORIGIN}/big-brother/signals]Все сигналы и лента людей[/URL]`;
  if (!lines.length) return `${head}\nОтклонений нет — все в своей норме.\n${link}`;
  return `${head}\n${lines.slice(0, MAX_LINES).join('\n')}\n${link}\n[I]Только подсказка: сотрудникам ничего не отправлялось.[/I]`;
}

/** Пользователь Монолитики по Битрикс-id. */
async function userByBitrix(bitrixId: string): Promise<SessionUser | null> {
  const r = await systemDb().query<{ id: string }>(
    `SELECT id::text FROM users WHERE bitrix_user_id::text = $1 LIMIT 1`, [bitrixId],
  ).catch(() => ({ rows: [] as { id: string }[] }));
  return r.rows[0] ? loadSessionUserById(r.rows[0].id) : null;
}

/** Плановый прогон (понедельник): по настройкам — получателям или в предпросмотр. */
export async function runBigBrotherDigest(now = Date.now()): Promise<string> {
  const s = await loadDigestSettings();
  if (!s.installed || !s.enabled) return 'disabled';
  const to = s.mode === 'live' ? s.recipients : [s.previewTo];
  const out: string[] = [];
  for (const rid of to) {
    const user = await userByBitrix(rid);
    if (!user || !canViewBigBrother(user)) { out.push(`${rid}: нет доступа к разделу — пропущен`); continue; }
    const text = await buildDigestText(await scopedPeople(user), now);
    const sent = await sendBitrixBotMessage(rid, text, undefined, DIGEST_CHANNEL);
    out.push(`${rid}: ${sent ? 'отправлено' : 'не отправлено'}`);
  }
  return `${s.mode}: ${out.join('; ') || 'получателей нет'}`;
}

/** Кнопка «Отправить мне сейчас»: текст по срезу самого нажавшего и только ему. Идёт и при выключенной функции
 *  (как пробные отправки других функций), но не при общем рубильнике бота. */
export async function sendDigestToMe(user: SessionUser, now = Date.now()): Promise<{ sent: boolean; text: string }> {
  if (!user.bitrixUserId) throw new Error('У вашего пользователя не указан Битрикс-id — некуда отправить');
  const text = await buildDigestText(await scopedPeople(user), now);
  const id = await sendBitrixBotMessageWithImage(user.bitrixUserId, text, '', DIGEST_CHANNEL, { test: true });
  return { sent: id > 0, text };
}
