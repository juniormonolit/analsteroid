// «Сторож увольнений» (Увольнятор v4, владелец 24.11): бот «Аналитик» следит за чатом «Увольнения» и не даёт
// увольнению зависнуть.
//
// Чтение — ОПРОСОМ im.dialog.messages.get через вебхук (бот типа B получает групповые сообщения только при
// упоминании, перерегистрировать «Аналитика» нельзя). Курсор — id последнего обработанного сообщения; при первом
// запуске (cursor NULL) встаём на последнее сообщение и старые объявления НЕ обрабатываем. Опрос раз в POLL_MIN
// минут; два процесса не опросят одновременно — аренда next_poll_at в dismissal_watch_settings (UPDATE … RETURNING).
//
// На распознанного (parse.ts) — черновик Увольнятора (уже есть незавершённый — его) и ЛС руководителю: РОП →
// директор (department_director, нет — company_director) → Куликов. Срок — 18:00 МСК следующего рабочего дня
// (производственный календарь); не запустили — в 18:01 следующий уровень и ещё рабочий день; Куликову после
// срока — напоминание раз в рабочий день. Решено = прогон по сотруднику запущен. Дубли — в зеркало «Контроля
// звонков» (mirror_bitrix_user_id, пусто — 2098). Нераспознанное — ЛС автору + зеркало.
//
// v5 (владелец 24.11: «бот должен ебать по черновикам… либо уволь, либо удали черновик»): кейс заводится на ЛЮБОЙ
// черновик (origin manual — ручной в UI, пересбор, черновики до выката; срок от создания, прошедший — от сейчас с
// уровня 0); объявление в чате при открытом ручном кейсе к нему привязывается. Черновик удалён до запуска —
// кейс cancelled, в зеркало «отменено: черновик удалил(а) …». Каждое напоминание кончается выбором (choiceLine).
import { loadCallControlSettings } from '@/lib/bots/callControl';
import { sendBitrixBotMessage } from '@/lib/bitrix/notify';
import { analyticsDb, systemDb } from '@/lib/db/clients';
import { isWorkingDayJs } from '@/lib/metrics/productionCalendar';
import { PORTAL, readOne } from '../engine/bx';
import { protectedBitrixIds } from '../engine/scope';
import { activeRunFor, createRun } from '../engine/store';
import { findDismissalUser, userDirectory, userNameMap } from '../engine/users';
import { DISMISSAL_KINDS } from '../types';
import { DISMISS_RE, parseAnnouncement, resolveLine, type DirectoryUser } from './parse';

/** Александр Куликов — последний уровень эскалации. */
export const KULIKOV_BITRIX_ID = 5;
const OWNER_MIRROR_FALLBACK = '2098';
const POLL_MIN = 3;
const PAGE = 50;
const MAX_PAGES = 6;
const LEVEL_RU = ['РОП', 'директор', 'Куликов'] as const;

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const appBase = () => (process.env.APP_BASE_URL || 'https://monolitika.mlt-it.ru').replace(/\/$/, '');
const bbSafe = (s: string) => s.replace(/[[\]]/g, ' ').trim();

// ── Календарь ─────────────────────────────────────────────────────────────────
const mskDate = (d: Date) => d.toLocaleDateString('sv-SE', { timeZone: 'Europe/Moscow' });
function addDays(day: string, n: number): string {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function isWorking(day: string): boolean {
  const d = new Date(`${day}T12:00:00Z`);
  return isWorkingDayJs(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), d.getUTCDay() || 7);
}
/** 18:00 МСК первого рабочего дня ПОСЛЕ МСК-даты момента `from`. */
export function nextDeadline(from: Date): Date {
  let day = addDays(mskDate(from), 1);
  for (let i = 0; i < 30 && !isWorking(day); i++) day = addDays(day, 1);
  return new Date(`${day}T18:00:00+03:00`);
}
const WD = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];
function fmtDeadline(d: Date): string {
  const day = mskDate(d);
  const [, m, dd] = day.split('-');
  return `18:00 ${dd}.${m} (${WD[new Date(`${day}T12:00:00Z`).getUTCDay()]})`;
}

// ── Настройки и аренда опроса ──────────────────────────────────────────────────
interface Settings { dryRun: boolean; chatId: string; cursor: number | null; lastError: string | null }

async function claimPoll(): Promise<Settings | null> {
  // last_error — значение ДО этого опроса (RETURNING видит строку после SET, а last_error здесь не меняется).
  const r = await systemDb().query<{ dry_run: boolean; chat_id: string; cursor: string | null; last_error: string | null }>(
    `UPDATE dismissal_watch_settings SET next_poll_at = now() + make_interval(mins => $1), last_poll_at = now(), updated_at = now()
      WHERE id = 1 AND enabled AND (next_poll_at IS NULL OR next_poll_at <= now())
      RETURNING dry_run, chat_id, cursor::text, last_error`, [POLL_MIN],
  );
  const s = r.rows[0];
  return s ? { dryRun: s.dry_run, chatId: s.chat_id, cursor: s.cursor ? Number(s.cursor) : null, lastError: s.last_error } : null;
}
// Чаты (миграция 301, владелец 27.11: «за чатом стажёров тоже надо следить»): у каждого свой курсор.
// settings.chat_id/cursor после 301 не используются (перенесены в dismissal_watch_chats).
interface WatchChat { chatId: string; title: string; cursor: number | null }
const chatTitles = new Map<string, string>();
const chatTitle = (chatId: string | null | undefined) => (chatId && chatTitles.get(chatId)) || 'Увольнения';
async function loadChats(): Promise<WatchChat[]> {
  const r = await systemDb().query<{ chat_id: string; title: string; cursor: string | null }>(
    `SELECT chat_id, title, cursor::text FROM dismissal_watch_chats WHERE enabled ORDER BY chat_id`,
  );
  for (const c of r.rows) chatTitles.set(c.chat_id, c.title);
  return r.rows.map(c => ({ chatId: c.chat_id, title: c.title, cursor: c.cursor ? Number(c.cursor) : null }));
}
const saveCursor = (chatId: string, id: number) => systemDb().query(
  `UPDATE dismissal_watch_chats SET cursor = $2, updated_at = now() WHERE chat_id = $1 AND (cursor IS NULL OR cursor < $2)`, [chatId, id],
);
const saveError = (e: string | null) => systemDb().query(`UPDATE dismissal_watch_settings SET last_error = $1, updated_at = now() WHERE id = 1`, [e]);

// ── Сообщения ───────────────────────────────────────────────────────────────
async function mirrorId(): Promise<string> {
  const s = await loadCallControlSettings().catch(() => null);
  return s?.mirrorBitrixUserId || OWNER_MIRROR_FALLBACK;
}

/** ЛС адресату + дубль в зеркало. Возвращает id сообщения адресату (0 — не ушло). */
async function sendWithMirror(to: number | null, toName: string, text: string, opts: { mirrorOnly?: boolean; tag?: string } = {}): Promise<{ id: number; mirrored: boolean; error: string | null }> {
  let id = 0, error: string | null = null;
  if (to && !opts.mirrorOnly) {
    try { id = await sendBitrixBotMessage(String(to), text, undefined, 'dismissal'); if (!id) error = 'бот не отправил (функция «Увольнятор» выключена?)'; } catch (e) { error = errMsg(e); }
  }
  let mirrored = false;
  const mirror = await mirrorId();
  if (String(to) !== mirror) {
    const head = opts.mirrorOnly ? `[I]Сторож увольнений${opts.tag ? ` · ${opts.tag}` : ''}[/I]` : `[I]Дубль → ${bbSafe(toName)}${error ? ` (НЕ ДОСТАВЛЕНО: ${bbSafe(error)})` : ''}[/I]`;
    try { mirrored = !!(await sendBitrixBotMessage(mirror, `${head}\n${text}`, undefined, 'dismissal')); } catch { /* зеркало не критично */ }
  }
  return { id, mirrored, error };
}

const messageUrl = (chatId: string, id: number) => `${PORTAL}/online/?IM_DIALOG=${chatId}&IM_MESSAGE=${id}`;

// ── Оргструктура: кому писать ────────────────────────────────────────────────
export interface Chain { rop: number | null; director: number | null }
/** РОП и директор уволенного (сам себе не руководитель). Уволенный — РОП: уровнем 0 станет директор. */
export async function chainOf(sourceId: number): Promise<Chain> {
  const r = await analyticsDb().query<{ rop: string | null; dd: string | null; cd: string | null }>(
    `SELECT rop_bitrix_user_id AS rop, department_director_bitrix_user_id AS dd, company_director_bitrix_user_id AS cd
       FROM sa.org_resolved_hierarchy WHERE manager_bitrix_user_id = $1 ORDER BY is_active DESC NULLS LAST LIMIT 1`, [String(sourceId)],
  );
  const row = r.rows[0];
  const ok = (v: string | null | undefined) => { const n = Number(v); return n > 0 && n !== sourceId ? n : null; };
  const rop = ok(row?.rop);
  const director = [ok(row?.dd), ok(row?.cd)].find(x => x && x !== rop) ?? null;
  return { rop, director };
}
/** Получатель уровня; null — уровня нет (тогда следующий). */
const recipientAt = (c: Chain, level: number): number | null => (level === 0 ? c.rop : level === 1 ? c.director : KULIKOV_BITRIX_ID);
/** Первый существующий уровень начиная с `from` (Куликов есть всегда). */
function firstLevel(c: Chain, from: number): 0 | 1 | 2 {
  for (let l = from; l < 2; l++) if (recipientAt(c, l)) return l as 0 | 1;
  return 2;
}

// ── Кейсы ───────────────────────────────────────────────────────────────────
// v5: кейс = прогон (unique run_id). origin chat — из чата «Увольнения»; manual — любой черновик без объявления
// (ручной в UI, пересбор старого). Решено: started — запущен; cancelled — черновик удалён до запуска.
interface CaseRow {
  id: string; origin: 'chat' | 'manual'; chat_id: string | null; message_id: string | null; source_bitrix_id: string; source_name: string;
  announced_at: Date; run_id: string | null; level: number; deadline: Date; notifications: Notification[];
  created_by_name: string | null;
}
interface Notification { level: number; bitrixId: number; name: string; at: string; messageId: number; mirrored: boolean; error: string | null; repeat?: boolean }

async function addNotification(caseId: string, n: Notification, patch: { level?: number; deadline?: Date } = {}) {
  await systemDb().query(
    `UPDATE dismissal_watch_cases SET notifications = notifications || $2::jsonb,
            level = coalesce($3, level), deadline = coalesce($4, deadline), updated_at = now() WHERE id = $1`,
    [caseId, JSON.stringify([n]), patch.level ?? null, patch.deadline ?? null],
  );
}

const draftUrl = (runId: string | null) => (runId ? `${appBase()}/dismissal/${runId}` : `${appBase()}/dismissal`);
function runLink(runId: string | null): string {
  return `[URL=${draftUrl(runId)}]${runId ? 'открыть в Увольняторе' : 'Увольнятор'}[/URL]`;
}
/** Обязательная концовка каждого напоминания (владелец 24.11: «либо уволь, либо удали черновик»). */
function choiceLine(runId: string | null): string {
  const u = draftUrl(runId);
  return `Либо [URL=${u}]проведите увольнение[/URL] (запустите черновик), либо [URL=${u}]удалите черновик[/URL], если увольнение отменено.`;
}
const ddmm = (d: Date) => mskDate(d).split('-').reverse().join('.');
function originText(c: Pick<CaseRow, 'origin' | 'chat_id' | 'message_id' | 'announced_at' | 'created_by_name'>): string {
  if (c.origin === 'chat' && c.chat_id && c.message_id) return `объявлено ${ddmm(new Date(c.announced_at))} в [URL=${messageUrl(c.chat_id, Number(c.message_id))}]чате «${bbSafe(chatTitle(c.chat_id))}»[/URL]`;
  return `черновик заведён ${ddmm(new Date(c.announced_at))}${c.created_by_name ? ` (${bbSafe(c.created_by_name)})` : ''}`;
}

// ── Разбор нового сообщения ─────────────────────────────────────────────────
interface ChatMessage { id: number; author_id: number; date: string; text?: string }

/** Привязать объявление к уже открытому ручному кейсу (без второго «первого» сообщения). */
async function attachChat(where: { caseId?: string; runId?: string }, chat: WatchChat, m: ChatMessage, line: string, author: number | null, authorName: string): Promise<boolean> {
  const r = await systemDb().query(
    `UPDATE dismissal_watch_cases SET origin = 'chat', chat_id = $3, message_id = $4, message_text = $5, line = $6,
            author_bitrix_id = $7, author_name = $8, updated_at = now()
      WHERE ${where.caseId ? 'id = $1' : 'run_id = $2'} AND message_id IS NULL AND resolved_at IS NULL`,
    [where.caseId ?? null, where.runId ?? null, chat.chatId, m.id, m.text ?? '', line, author, authorName],
  );
  return (r.rowCount ?? 0) > 0;
}

async function handleMessage(s: Settings, chat: WatchChat, m: ChatMessage, authorName: string, dir: DirectoryUser[], prot: Set<number>): Promise<void> {
  const lines = parseAnnouncement(m.text ?? '');
  if (!lines.length) return;
  const announcedAt = new Date(m.date);
  const author = Number(m.author_id) || null;
  const msgUrl = messageUrl(chat.chatId, m.id);
  const inChat = `в чате «${bbSafe(chat.title)}»`;
  for (const p of lines) {
    const res = resolveLine(p, dir);
    if (!res.ok) {
      const text = `Не понял, кого уволили: „${bbSafe(p.line)}“ (${bbSafe(res.reason)}). Отметьте сотрудника через @ ${inChat} — я подхвачу.`;
      await sendWithMirror(s.dryRun ? null : author, authorName, text, s.dryRun ? { mirrorOnly: true, tag: 'тест, автору не отправлено' } : {});
      console.log(`[dismissal-watch] #${m.id}: не распознано «${p.line}» — ${res.reason}`);
      continue;
    }
    const sourceId = res.bitrixId;
    const who = dir.find(u => u.bitrixId === sourceId);
    const name = who?.name ?? `#${sourceId}`;
    const login = p.login ?? who?.login ?? null;
    const label = `${bbSafe(name)}${login ? ` (${bbSafe(login)})` : ''}`;
    if (prot.has(sourceId)) {
      await sendWithMirror(null, '', `В чате «${bbSafe(chat.title)}» объявлено увольнение ${label}, но это администратор Монолитики — Увольнятор его не трогает. [URL=${msgUrl}]Сообщение[/URL]`, { mirrorOnly: true, tag: 'администратор' });
      continue;
    }
    // Открытый кейс по сотруднику: ручной — привязываем объявление; чатовый — повторное объявление, игнор.
    const open = await systemDb().query<{ id: string; message_id: string | null; run_id: string | null }>(
      `SELECT id::text, message_id::text, run_id::text FROM dismissal_watch_cases WHERE source_bitrix_id = $1 AND resolved_at IS NULL ORDER BY id DESC LIMIT 1`, [sourceId],
    );
    if (open.rows[0]) {
      const o = open.rows[0];
      if (!o.message_id && !s.dryRun && await attachChat({ caseId: o.id }, chat, m, p.line, author, authorName)) {
        await sendWithMirror(null, '', `Объявление про ${label} привязал к уже заведённому черновику (${runLink(o.run_id)}) — срок и эскалация прежние.`, { mirrorOnly: true, tag: 'объявление к черновику' });
      } else console.log(`[dismissal-watch] #${m.id}: по ${name} уже есть открытый кейс`);
      continue;
    }
    // Уже проведено через Увольнятор (запущен за 30 дней до объявления или позже) — кейс сразу решён.
    const done = await systemDb().query<{ id: string; started_at: Date | null; updated_at: Date }>(
      `SELECT id::text, started_at, updated_at FROM dismissal_runs
        WHERE source_bitrix_id = $1 AND (started_at IS NOT NULL OR status IN ('queued', 'running', 'paused', 'done'))
          AND created_at >= $2::timestamptz - interval '30 days' ORDER BY created_at DESC LIMIT 1`, [sourceId, announcedAt],
    );
    const chain = await chainOf(sourceId).catch(() => ({ rop: null, director: null } as Chain));
    const level = firstLevel(chain, 0);
    const to = recipientAt(chain, level)!;
    const deadline = nextDeadline(announcedAt);
    if (s.dryRun) {
      const names = await userNameMap([to]);
      await sendWithMirror(null, '', `Распознал: ${label} (${res.via}) — „${bbSafe(p.line)}“. Написал бы: ${LEVEL_RU[level]} ${bbSafe(names[to] ?? `#${to}`)}, срок ${fmtDeadline(deadline)}.${done.rowCount ? ' Прогон уже запущен — кейс был бы сразу решён.' : ''}`, { mirrorOnly: true, tag: 'тест' });
      continue;
    }
    if (done.rowCount) {
      const d = done.rows[0];
      // У запущенного прогона кейс мог уже быть (ручной) — тогда новый не нужен (ON CONFLICT по run_id).
      await systemDb().query(
        `INSERT INTO dismissal_watch_cases (origin, chat_id, message_id, message_text, line, source_bitrix_id, source_name, author_bitrix_id, author_name,
                                            announced_at, run_id, level, deadline, resolved_at, resolved_run_id, resolution)
         VALUES ('chat',$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$10,'started') ON CONFLICT DO NOTHING`,
        [chat.chatId, m.id, m.text ?? '', p.line, sourceId, name, author, authorName, announcedAt, d.id, level, deadline, d.started_at ?? d.updated_at],
      );
      await sendWithMirror(null, '', `Объявлено увольнение ${label} — прогон Увольнятора по нему уже запущен, напоминать некому. ${runLink(d.id)}`, { mirrorOnly: true, tag: 'уже проведено' });
      continue;
    }
    // Черновик: незавершённый прогон по сотруднику — его, иначе новый (сбор подхватит воркер). Прошлый кейс
    // отменён (черновик удалили) — открытого нет, сюда и попадаем: новый кейс и новый черновик.
    let runId = await activeRunFor(sourceId);
    if (!runId) {
      const src = await findDismissalUser(sourceId);
      if (!src) { console.warn(`[dismissal-watch] #${m.id}: пользователь #${sourceId} пропал из справочника`); continue; }
      runId = await createRun(src, { login: 'bot:dismissal-watch', name: `Бот «Аналитик» (чат «${chat.title}»)`, bitrixId: author }, m.text ?? p.line);
    }
    const ins = await systemDb().query<{ id: string }>(
      `INSERT INTO dismissal_watch_cases (origin, chat_id, message_id, message_text, line, source_bitrix_id, source_name, author_bitrix_id, author_name,
                                          announced_at, run_id, level, deadline)
       VALUES ('chat',$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT DO NOTHING RETURNING id::text`,
      [chat.chatId, m.id, m.text ?? '', p.line, sourceId, name, author, authorName, announcedAt, runId, level, deadline],
    );
    if (!ins.rows[0]) {
      // Кейс по черновику уже завёл обход черновиков (гонка) — привязываем объявление; или повтор после сбоя.
      await attachChat({ runId }, chat, m, p.line, author, authorName).catch(() => false);
      continue;
    }
    const nextTo = level < 2 ? recipientAt(chain, firstLevel(chain, level + 1)) : null;
    const names = await userNameMap([to, ...(nextTo ? [nextTo] : [])]);
    const text = [
      `[B]Уволен(а) ${label}[/B]`,
      `Написал(а) ${bbSafe(authorName)} ${inChat}: [URL=${msgUrl}]сообщение[/URL].`,
      `Подготовил черновик передачи его сделок и задач: ${runLink(runId)}.`,
      `Срок — ${fmtDeadline(deadline)}.${nextTo ? ` Иначе — эскалация: ${bbSafe(names[nextTo] ?? `#${nextTo}`)}.` : ''}`,
      choiceLine(runId),
    ].join('\n');
    const sent = await sendWithMirror(to, names[to] ?? `#${to}`, text);
    await addNotification(ins.rows[0].id, { level, bitrixId: to, name: names[to] ?? `#${to}`, at: new Date().toISOString(), messageId: sent.id, mirrored: sent.mirrored, error: sent.error });
    console.log(`[dismissal-watch] #${m.id}: ${name} (#${sourceId}, ${res.via}) → прогон ${runId}, ${LEVEL_RU[level]} #${to}${sent.error ? ` — НЕ доставлено: ${sent.error}` : ''}`);
  }
}

async function pollChat(s: Settings): Promise<void> {
  // Чаты по очереди; ошибка одного не мешает другим, но всплывает в общий алерт.
  const errors: string[] = [];
  for (const chat of await loadChats()) {
    try { await pollOne(s, chat); } catch (e) { errors.push(`«${chat.title}»: ${errMsg(e)}`); }
  }
  if (errors.length) throw new Error(errors.join('; '));
}

async function pollOne(s: Settings, chat: WatchChat): Promise<void> {
  if (chat.cursor === null) {
    // Первый запуск чата: встаём на последнее сообщение, историю не разбираем.
    const r = await readOne<{ messages: ChatMessage[] }>('im.dialog.messages.get', { DIALOG_ID: chat.chatId, LIMIT: 1 });
    const last = Math.max(0, ...(r?.messages ?? []).map(m => Number(m.id)));
    if (last) await saveCursor(chat.chatId, last);
    console.log(`[dismissal-watch] старт чата «${chat.title}»: курсор = ${last} (старые объявления не обрабатываем)`);
    return;
  }
  let cursor = chat.cursor;
  let dir: DirectoryUser[] | null = null;
  let prot: Set<number> | null = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const r = await readOne<{ messages: ChatMessage[]; users?: { id: number; name?: string }[] }>('im.dialog.messages.get', { DIALOG_ID: chat.chatId, FIRST_ID: cursor, LIMIT: PAGE });
    const msgs = (r?.messages ?? []).filter(m => Number(m.id) > cursor).sort((a, b) => Number(a.id) - Number(b.id));
    if (!msgs.length) break;
    const userName = new Map((r.users ?? []).map(u => [Number(u.id), u.name ?? `#${u.id}`]));
    for (const m of msgs) {
      if (Number(m.author_id) > 0 && DISMISS_RE.test(m.text ?? '')) {
        dir ??= await userDirectory();
        prot ??= await protectedBitrixIds();
        await handleMessage(s, chat, m, userName.get(Number(m.author_id)) ?? `#${m.author_id}`, dir, prot);
      }
      cursor = Number(m.id);
      await saveCursor(chat.chatId, cursor);
    }
    if (msgs.length < PAGE) break;
  }
}

// ── Черновики без кейса (v5: «бот ебёт по черновикам») ──────────────────────
/** Любой черновик (scanning/draft) без кейса — завести ручной кейс и написать уровню 0. Срок — от создания
 *  черновика; уже прошёл (черновики, жившие до выката v5) — новый срок от сейчас, но начинаем с уровня 0. */
async function caseDrafts(prot: Set<number>): Promise<void> {
  const r = await systemDb().query<{ id: string; source_bitrix_id: string; name: string | null; created_at: Date; created_by_name: string | null; created_by_bitrix_id: string | null }>(
    `SELECT r.id::text, r.source_bitrix_id::text, r.source->>'name' AS name, r.created_at, r.created_by_name, r.created_by_bitrix_id::text
       FROM dismissal_runs r
      WHERE r.status IN ('scanning', 'draft')
        AND NOT EXISTS (SELECT 1 FROM dismissal_watch_cases c WHERE c.run_id = r.id)
        AND NOT EXISTS (SELECT 1 FROM dismissal_watch_cases c WHERE c.source_bitrix_id = r.source_bitrix_id AND c.resolved_at IS NULL)
        AND NOT EXISTS (SELECT 1 FROM dismissal_items i WHERE i.run_id = r.id AND NOT (i.kind = ANY($1::text[])))
      ORDER BY r.created_at LIMIT 20`, [DISMISSAL_KINDS as unknown as string[]],
  );
  for (const run of r.rows) {
    const sourceId = Number(run.source_bitrix_id);
    if (prot.has(sourceId)) continue;
    try {
      const name = run.name || `#${sourceId}`;
      const chain = await chainOf(sourceId).catch(() => ({ rop: null, director: null } as Chain));
      const level = firstLevel(chain, 0);
      const to = recipientAt(chain, level)!;
      let deadline = nextDeadline(new Date(run.created_at));
      if (deadline.getTime() <= Date.now()) deadline = nextDeadline(new Date());
      const ins = await systemDb().query<{ id: string }>(
        `INSERT INTO dismissal_watch_cases (origin, source_bitrix_id, source_name, announced_at, run_id, level, deadline)
         VALUES ('manual', $1, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING RETURNING id::text`,
        [sourceId, name, run.created_at, run.id, level, deadline],
      );
      if (!ins.rows[0]) continue;
      const creator = Number(run.created_by_bitrix_id) || null;
      const nextTo = level < 2 ? recipientAt(chain, firstLevel(chain, level + 1)) : null;
      const names = await userNameMap([to, ...(nextTo ? [nextTo] : [])]);
      const escal = nextTo ? ` Иначе — эскалация: ${bbSafe(names[nextTo] ?? `#${nextTo}`)}.` : '';
      const text = creator === to ? [
        `[B]Черновик увольнения ${bbSafe(name)} заведён[/B] — срок ${fmtDeadline(deadline)}.${escal}`,
        choiceLine(run.id),
      ].join('\n') : [
        `[B]Черновик увольнения: ${bbSafe(name)}[/B]`,
        `${bbSafe(run.created_by_name || 'Кто-то')} завёл(а) в Увольняторе черновик передачи его сделок и задач: ${runLink(run.id)}.`,
        `Срок — ${fmtDeadline(deadline)}.${escal}`,
        choiceLine(run.id),
      ].join('\n');
      const sent = await sendWithMirror(to, names[to] ?? `#${to}`, text);
      await addNotification(ins.rows[0].id, { level, bitrixId: to, name: names[to] ?? `#${to}`, at: new Date().toISOString(), messageId: sent.id, mirrored: sent.mirrored, error: sent.error });
      console.log(`[dismissal-watch] черновик ${run.id} (${name}): ручной кейс → ${LEVEL_RU[level]} #${to}${sent.error ? ` — НЕ доставлено: ${sent.error}` : ''}`);
    } catch (e) {
      console.error(`[dismissal-watch] черновик ${run.id}:`, errMsg(e));
    }
  }
}

// ── Решено: запуск / отмена ─────────────────────────────────────────────────
/** started — по сотруднику запущен прогон (свой черновик кейса или любой, созданный не раньше чем за 30 дней).
 *  cancelled — черновик кейса удалён ДО запуска и другого живого черновика нет. Черновик кейса не живой, но есть
 *  другой живой без кейса (упал на сборе → завели новый) — кейс переезжает на него. Отмена ПОСЛЕ запуска кейс не
 *  трогает: он уже решён стартом. */
async function resolveCases(): Promise<void> {
  await systemDb().query(
    `UPDATE dismissal_watch_cases c SET resolved_at = x.at, resolved_run_id = x.run_id, resolution = 'started', updated_at = now()
       FROM (SELECT DISTINCT ON (c2.id) c2.id AS case_id, r.id AS run_id, coalesce(r.started_at, r.updated_at) AS at
               FROM dismissal_watch_cases c2
               JOIN dismissal_runs r ON r.source_bitrix_id = c2.source_bitrix_id
              WHERE c2.resolved_at IS NULL
                AND (r.started_at IS NOT NULL OR r.status IN ('queued', 'running', 'paused', 'done'))
                AND (r.id = c2.run_id OR r.created_at >= c2.announced_at - interval '30 days')
              ORDER BY c2.id, r.created_at DESC) x
      WHERE c.id = x.case_id`,
  );
  const r = await systemDb().query<{ id: string; source_bitrix_id: string; source_name: string; run_id: string; status: string; cancelled_by_name: string | null; at: Date }>(
    `SELECT c.id::text, c.source_bitrix_id::text, c.source_name, c.run_id::text, r.status, r.cancelled_by_name, coalesce(r.cancelled_at, r.updated_at) AS at
       FROM dismissal_watch_cases c JOIN dismissal_runs r ON r.id = c.run_id
      WHERE c.resolved_at IS NULL AND r.status NOT IN ('scanning', 'draft', 'queued', 'running', 'paused') AND r.started_at IS NULL`,
  );
  for (const c of r.rows) {
    try {
      const sourceId = Number(c.source_bitrix_id);
      const active = await activeRunFor(sourceId);
      if (active && active !== c.run_id) {
        const moved = await systemDb().query(
          `UPDATE dismissal_watch_cases SET run_id = $2, updated_at = now() WHERE id = $1 AND NOT EXISTS (SELECT 1 FROM dismissal_watch_cases WHERE run_id = $2)`, [c.id, active],
        );
        if (moved.rowCount) { console.log(`[dismissal-watch] кейс ${c.id}: черновик ${c.run_id} → ${active}`); continue; }
      }
      if (c.status !== 'cancelled') continue; // упал на сборе — ждём пересбора, кейс открыт
      const upd = await systemDb().query(
        `UPDATE dismissal_watch_cases SET resolved_at = $2, resolution = 'cancelled', cancelled_by = $3, updated_at = now() WHERE id = $1 AND resolved_at IS NULL`,
        [c.id, c.at, c.cancelled_by_name],
      );
      if (!upd.rowCount) continue;
      await sendWithMirror(null, '', `Увольнение ${bbSafe(c.source_name)} отменено: черновик удалил(а) ${bbSafe(c.cancelled_by_name || 'неизвестно кто')}. Напоминания остановлены.`, { mirrorOnly: true, tag: 'отмена' });
      console.log(`[dismissal-watch] кейс ${c.id} (${c.source_name}): отменён — ${c.cancelled_by_name ?? '?'}`);
    } catch (e) {
      console.error(`[dismissal-watch] кейс ${c.id} (отмена):`, errMsg(e));
    }
  }
}

async function escalate(): Promise<void> {
  const r = await systemDb().query<CaseRow>(
    `SELECT c.id::text, c.origin, c.chat_id, c.message_id::text, c.source_bitrix_id::text, c.source_name,
            c.announced_at, c.run_id::text, c.level, c.deadline, c.notifications, r.created_by_name
       FROM dismissal_watch_cases c LEFT JOIN dismissal_runs r ON r.id = c.run_id
      WHERE c.resolved_at IS NULL AND c.deadline + interval '1 minute' <= now() ORDER BY c.deadline LIMIT 20`,
  );
  for (const c of r.rows) {
    try {
      const sourceId = Number(c.source_bitrix_id);
      const chain = await chainOf(sourceId).catch(() => ({ rop: null, director: null } as Chain));
      const repeat = c.level >= 2;
      const level = repeat ? 2 : firstLevel(chain, c.level + 1);
      const to = recipientAt(chain, level)!;
      const deadline = nextDeadline(new Date());
      const runId = (await activeRunFor(sourceId)) ?? c.run_id;
      const prev = [...(c.notifications ?? [])].reverse().find(n => n.level === c.level);
      const nextTo = level < 2 ? recipientAt(chain, firstLevel(chain, level + 1)) : null;
      const names = await userNameMap([to, ...(nextTo ? [nextTo] : [])]);
      const label = bbSafe(c.source_name);
      const origin = originText(c);
      const text = repeat ? [
        `[B]Увольнение ${label} так и не проведено[/B] (${origin}).`,
        `Черновик: ${runLink(runId)}. Напомню снова после ${fmtDeadline(deadline)}.`,
        choiceLine(runId),
      ].join('\n') : [
        `[B]${bbSafe(prev?.name ?? LEVEL_RU[c.level])} не провёл(а) увольнение ${label} в срок[/B] (${origin}; срок был ${fmtDeadline(new Date(c.deadline))}).`,
        `Черновик передачи сделок и задач: ${runLink(runId)}. Новый срок — ${fmtDeadline(deadline)}.${nextTo ? ` Иначе — эскалация: ${bbSafe(names[nextTo] ?? `#${nextTo}`)}.` : ''}`,
        choiceLine(runId),
      ].join('\n');
      const sent = await sendWithMirror(to, names[to] ?? `#${to}`, text);
      await addNotification(c.id, { level, bitrixId: to, name: names[to] ?? `#${to}`, at: new Date().toISOString(), messageId: sent.id, mirrored: sent.mirrored, error: sent.error, ...(repeat ? { repeat: true } : {}) }, { level, deadline });
      console.log(`[dismissal-watch] кейс ${c.id} (${c.source_name}): ${repeat ? 'повтор' : 'эскалация'} → ${LEVEL_RU[level]} #${to}`);
    } catch (e) {
      console.error(`[dismissal-watch] эскалация кейса ${c.id}:`, errMsg(e));
    }
  }
}

// ── Тик ─────────────────────────────────────────────────────────────────────
const g = globalThis as unknown as { __dismissalWatchBusy?: boolean };

/** Тик сторожа: зовётся воркером Увольнятора часто, реальная работа — раз в POLL_MIN минут (аренда в БД). */
export async function dismissalWatchTick(): Promise<void> {
  if (g.__dismissalWatchBusy) return;
  g.__dismissalWatchBusy = true;
  try {
    const s = await claimPoll();
    if (!s) return;
    let err: string | null = null;
    try { await pollChat(s); } catch (e) { err = `опрос: ${errMsg(e)}`; console.error('[dismissal-watch] опрос чата:', errMsg(e)); }
    if (!s.dryRun) {
      // Порядок: сначала закрыть решённые (запуск/отмена), потом завести кейсы новым черновикам, потом эскалация.
      try {
        await resolveCases();
        await caseDrafts(await protectedBitrixIds());
        await escalate();
      } catch (e) { err = `${err ? `${err}; ` : ''}эскалация: ${errMsg(e)}`; console.error('[dismissal-watch] эскалация:', errMsg(e)); }
    }
    await saveError(err).catch(() => {});
    // Алерт владельцу (24.11: «пусть пишет мне при ошибке»): только на переходах «работало → ошибка» и
    // «ошибка → снова работает», чтобы не слать сообщение каждые POLL_MIN минут. Тип ошибки сменился — тоже пишем.
    const kind = (e: string | null) => (e ? e.replace(/\d+/g, '#').slice(0, 120) : null);
    if (kind(err) !== kind(s.lastError)) {
      const text = err
        ? `[B]Сторож увольнений не работает[/B]\nНе могу прочитать или обработать чаты увольнений: ${bbSafe(err).slice(0, 600)}\nЧаще всего — аккаунт вебхука убрали из чата или вебхук отозван. Напишу, когда заработает.`
        : `[B]Сторож увольнений снова работает[/B]\nЧаты увольнений читаются, пропущенные сообщения разобраны.`;
      await sendWithMirror(null, '', text, { mirrorOnly: true, tag: err ? 'ошибка' : 'восстановлено' }).catch(() => {});
    }
  } catch (e) {
    // До наката миграции 291 таблиц нет — молчим (раз в тик не спамим лог).
    if ((e as { code?: string }).code !== '42P01') console.error('[dismissal-watch] тик:', errMsg(e));
  } finally {
    g.__dismissalWatchBusy = false;
  }
}
