import { systemDb } from '@/lib/db/clients';
import { loadSessionUserByLogin } from '@/lib/auth/session';
import { buildMyReportSpec } from '@/lib/reports-builder/buildMyReport';
import { buildReportText } from '@/features/reports-builder/engine/buildReportText';
import { channelEnabled, sendBitrixBotMessage } from '@/lib/bitrix/notify';

// Авторассылка сохранённых шаблонов «Мой отчёт» ботом «Аналитик» (задача владельца
// 09.09.2026: «выбираю отчёт из всех сохранённых, получателя, время — по умолчанию
// 18:00 — и галочкой дни недели»).
//
// Два рубильника, оба обязаны быть включены: функция бота `report_schedules`
// (общий, в «Настройки → Боты → Аналитик») и `enabled` конкретного расписания.
//
// Отчёт собирается ГЛАЗАМИ ВЛАДЕЛЬЦА ШАБЛОНА (owner_login): его доступ к отделам/
// филиалам, его «я» в сущности self — ровно то, что он видит у себя в конструкторе.
// Получатель может быть кем угодно: он получает то, что настроил владелец.
//
// Тик — раз в минуту по МСК. «Пора» = send_time уже наступило, но не раньше пяти
// минут назад (иначе после рестарта сервера в 18:07 ушло бы всё «за 18:00» ещё раз
// — нет, ушло бы один раз: страховка last_sent_at::date тоже стоит) и сегодня ещё
// не отправляли. Дата отправки фиксируется ДО отправки — второй инстанс/повторный
// тик не продублирует сообщение; неудача пишется в last_error и повторяется не
// раньше следующего дня (ручной повтор — «Отправить сейчас» в настройках).

interface ScheduleRow {
  id: string; template_id: string; owner_login: string; recipient_bitrix_id: string;
  template_name: string | null; state: Record<string, unknown> | null;
}

function mskNow(): { date: string; hhmm: string; isoWeekday: number } {
  const msk = new Date().toLocaleString('sv-SE', { timeZone: 'Europe/Moscow' }); // 'YYYY-MM-DD HH:mm:ss'
  const [date, time] = msk.split(' ');
  const jsDow = new Date(`${date}T12:00:00Z`).getUTCDay(); // 0 = вс
  return { date, hhmm: time.slice(0, 5), isoWeekday: jsDow === 0 ? 7 : jsDow };
}

/** Собрать и отправить одно расписание. Бросает — вызывающий решает, что делать. */
async function deliver(row: ScheduleRow): Promise<void> {
  if (!row.state) throw new Error('Шаблон отчёта удалён');
  const owner = await loadSessionUserByLogin(row.owner_login);
  if (!owner) throw new Error(`Владелец шаблона «${row.owner_login}» не найден или отключён`);
  const { spec } = await buildMyReportSpec(owner, row.state);
  const text = buildReportText(spec);
  const sent = await sendBitrixBotMessage(row.recipient_bitrix_id, text, undefined, 'report_schedules');
  if (!sent) throw new Error('Функция «Авторассылка сохранённых отчётов» выключена — сообщение не ушло');
}

/** Тик планировщика. Возвращает число отправленных (для лога). */
export async function runDueReportSchedules(): Promise<number> {
  // Дорого считать отчёты, если рассылка заглушена целиком.
  if (!(await channelEnabled('report_schedules'))) return 0;

  const { date, hhmm, isoWeekday } = mskNow();
  const db = systemDb();
  // Забираем «созревшие» и сразу помечаем сегодняшней датой — атомарно, чтобы
  // параллельный тик не взял те же строки.
  const due = await db.query<ScheduleRow>(
    `WITH picked AS (
       SELECT s.id FROM report_schedules s
        WHERE s.enabled
          AND $1 = ANY(s.weekdays)
          AND s.send_time <= $2::time
          AND s.send_time > ($2::time - interval '5 minutes')
          AND (s.last_sent_at IS NULL OR (s.last_sent_at AT TIME ZONE 'Europe/Moscow')::date < $3::date)
        FOR UPDATE SKIP LOCKED
     ),
     claimed AS (
       UPDATE report_schedules s SET last_sent_at = now(), last_error = NULL
         FROM picked WHERE s.id = picked.id
       RETURNING s.id, s.template_id, s.owner_login, s.recipient_bitrix_id
     )
     SELECT c.*, t.name AS template_name, t.state
       FROM claimed c LEFT JOIN report_templates t ON t.id = c.template_id`,
    [isoWeekday, hhmm, date],
  );

  let sent = 0;
  for (const row of due.rows) {
    try {
      await deliver(row);
      sent++;
      console.log(`[report-schedules] «${row.template_name}» → ${row.recipient_bitrix_id} отправлен (${date} ${hhmm})`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[report-schedules] «${row.template_name}» → ${row.recipient_bitrix_id} НЕ ушёл: ${msg}`);
      await db.query(`UPDATE report_schedules SET last_error = $2 WHERE id = $1`, [row.id, msg.slice(0, 500)]).catch(() => {});
    }
  }
  return sent;
}

/** «Отправить сейчас» из настроек — минуя расписание и дни недели, но НЕ минуя
 *  рубильник функции (иначе кнопка обходила бы «всё выключено»). */
export async function sendReportScheduleNow(id: string): Promise<void> {
  const r = await systemDb().query<ScheduleRow>(
    `SELECT s.id, s.template_id, s.owner_login, s.recipient_bitrix_id, t.name AS template_name, t.state
       FROM report_schedules s LEFT JOIN report_templates t ON t.id = s.template_id
      WHERE s.id = $1`,
    [id],
  );
  const row = r.rows[0];
  if (!row) throw new Error('Расписание не найдено');
  try {
    await deliver(row);
    await systemDb().query(`UPDATE report_schedules SET last_sent_at = now(), last_error = NULL WHERE id = $1`, [id]);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await systemDb().query(`UPDATE report_schedules SET last_error = $2 WHERE id = $1`, [id, msg.slice(0, 500)]).catch(() => {});
    throw e;
  }
}
