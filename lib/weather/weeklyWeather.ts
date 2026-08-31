import { systemDb, analyticsDb } from '@/lib/db/clients';
import { sendBitrixBotMessage } from '@/lib/bitrix/notify';
import { fetchWeekWeather, WEATHER_CITIES, type WeatherCity } from './openMeteo';

// Погодный контур спец-отчёта «Данные по годам» (решения владельца 28.08,
// дословно в BACKLOG): каждый понедельник в 09:00 МСК бот «Аналитик» спрашивает
// ответственного по каждому городу «Как погодка на той неделе была?», ответ
// пишется в weekly_weather.manual_text; параллельно Open-Meteo даёт автосводку.
// Живой комментарий главный, автоданные — приписка.

const CITIES = Object.keys(WEATHER_CITIES) as WeatherCity[];

// Дефолтные ответственные (владелец 28.08): Москва — 2098 (в миграции 164),
// «СПб — Осипов Сергей, Краснодар — Федоров Даниил (их айди посмотри сам)».
// Айди резолвятся ЛЕНИВО по имени из sa.org_resolved_hierarchy при первом
// обращении НА СЕРВЕРЕ: на момент постройки прямого доступа к sa с машины
// разработчика не было (28.08), а вбивать айди наугад хуже, чем найти по имени.
// Оба порядка слов и е/ё. Найденное фиксируется строкой в weather_responsibles —
// дальше правится руками в настройках, повторного поиска нет.
const DEFAULT_NAMES: Partial<Record<WeatherCity, string[]>> = {
  spb: ['Осипов Сергей', 'Сергей Осипов'],
  krd: ['Федоров Даниил', 'Даниил Федоров', 'Фёдоров Даниил', 'Даниил Фёдоров'],
};

export interface WeatherResponsible { city: WeatherCity; bitrixUserId: string; name: string | null }

async function resolveDefaultByName(city: WeatherCity): Promise<string | null> {
  const names = DEFAULT_NAMES[city];
  if (!names) return null;
  const res = await analyticsDb().query<{ id: string }>(
    `SELECT DISTINCT manager_bitrix_user_id::text AS id
       FROM sa.org_resolved_hierarchy
      WHERE manager_name = ANY($1) AND manager_bitrix_user_id IS NOT NULL
      ORDER BY id LIMIT 1`,
    [names],
  );
  return res.rows[0]?.id ?? null;
}

/** Ответственные по городам; недостающие дефолты резолвятся по имени и фиксируются. */
export async function getWeatherResponsibles(): Promise<WeatherResponsible[]> {
  const db = systemDb();
  const res = await db.query<{ city: WeatherCity; bitrix_user_id: string }>(
    'SELECT city, bitrix_user_id FROM weather_responsibles',
  );
  const have = new Map(res.rows.map(r => [r.city, r.bitrix_user_id]));
  for (const city of CITIES) {
    if (have.has(city)) continue;
    const id = await resolveDefaultByName(city).catch(() => null);
    if (id) {
      await db.query(
        `INSERT INTO weather_responsibles (city, bitrix_user_id) VALUES ($1, $2)
         ON CONFLICT (city) DO NOTHING`,
        [city, id],
      );
      have.set(city, id);
    }
  }
  // Имена — для UI настроек (не критично, если sa недоступна).
  const ids = [...new Set([...have.values()])];
  const nameById = new Map<string, string>();
  if (ids.length) {
    try {
      const names = await analyticsDb().query<{ id: string; name: string }>(
        `SELECT DISTINCT ON (manager_bitrix_user_id) manager_bitrix_user_id::text AS id, manager_name AS name
           FROM sa.org_resolved_hierarchy WHERE manager_bitrix_user_id::text = ANY($1)
          ORDER BY manager_bitrix_user_id, is_active DESC`,
        [ids],
      );
      for (const r of names.rows) nameById.set(r.id, r.name);
    } catch { /* имена — украшение */ }
  }
  return CITIES.filter(c => have.has(c)).map(city => ({
    city, bitrixUserId: have.get(city)!, name: nameById.get(have.get(city)!) ?? null,
  }));
}

export async function setWeatherResponsible(city: WeatherCity, bitrixUserId: string): Promise<void> {
  await systemDb().query(
    `INSERT INTO weather_responsibles (city, bitrix_user_id, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (city) DO UPDATE SET bitrix_user_id = EXCLUDED.bitrix_user_id, updated_at = now()`,
    [city, bitrixUserId],
  );
}

// ── недели (МСК, пн–вс) ──────────────────────────────────────────────────────

function mskToday(): string {
  return new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Moscow' });
}
/** Понедельник недели, которой принадлежит дата YYYY-MM-DD. */
export function mondayOf(ymd: string): string {
  const [y, m, d] = ymd.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  t.setUTCDate(t.getUTCDate() - ((t.getUTCDay() + 6) % 7));
  return t.toISOString().slice(0, 10);
}
function addDaysYmd(ymd: string, days: number): string {
  const [y, m, d] = ymd.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return t.toISOString().slice(0, 10);
}
const fmtRu = (ymd: string): string => `${ymd.slice(8, 10)}.${ymd.slice(5, 7)}`;

// ── понедельничный опрос ─────────────────────────────────────────────────────

/**
 * Тело крон-джобы (пн 09:00 МСК): для каждого города — строка weekly_weather за
 * ПРОШЛУЮ неделю, автосводка Open-Meteo, вопрос ответственному через бота.
 * Идемпотентна: повторный вызов не спрашивает дважды (asked_at) и не
 * перезатирает автосводку.
 */
export async function askWeeklyWeatherAll(): Promise<{ asked: number; autoFilled: number }> {
  const db = systemDb();
  const weekStart = mondayOf(addDaysYmd(mskToday(), -7)); // прошлая неделя
  const weekEnd = addDaysYmd(weekStart, 6);
  const responsibles = new Map((await getWeatherResponsibles()).map(r => [r.city, r.bitrixUserId]));
  let asked = 0, autoFilled = 0;

  for (const city of CITIES) {
    await db.query(
      `INSERT INTO weekly_weather (city, week_start) VALUES ($1, $2)
       ON CONFLICT (city, week_start) DO NOTHING`,
      [city, weekStart],
    );

    // Автосводка. Open-Meteo archive отстаёт на ~2-5 дней — в понедельник конец
    // недели может быть ещё пуст; следующий понедельник дозаполнит (условие
    // auto_summary IS NULL это позволяет).
    const auto = await fetchWeekWeather(city, weekStart, weekEnd);
    if (auto) {
      const r = await db.query(
        `UPDATE weekly_weather SET auto_summary = $3, auto_short = $4, auto_data = $5, updated_at = now()
          WHERE city = $1 AND week_start = $2 AND auto_summary IS NULL`,
        [city, weekStart, auto.summary, auto.short, JSON.stringify(auto)],
      );
      if (r.rowCount) autoFilled++;
    }

    const to = responsibles.get(city);
    if (!to) continue;
    const pending = await db.query<{ asked_at: Date | null }>(
      `SELECT asked_at FROM weekly_weather WHERE city = $1 AND week_start = $2`,
      [city, weekStart],
    );
    if (pending.rows[0]?.asked_at) continue; // уже спрашивали

    // Канал 'report': владелец назвал живой комментарий обязательным («это
    // обязательно») — вопрос часть отчётности и не должен глохнуть вместе с
    // развлекательными каналами в режиме тишины.
    const msgId = await sendBitrixBotMessage(
      to,
      `Как погодка на той неделе была? (${WEATHER_CITIES[city].label}, ${fmtRu(weekStart)}—${fmtRu(weekEnd)})\n`
      + `Ответь одним сообщением — я запишу его в отчёт «Данные по годам».`,
      undefined,
      'report',
    );
    // 0 = канал выключен, сообщение не ушло — asked_at НЕ ставим, следующий
    // тик/понедельник спросит снова.
    if (msgId > 0) {
      await db.query(
        `UPDATE weekly_weather SET asked_bitrix_id = $3, asked_at = now(), updated_at = now()
          WHERE city = $1 AND week_start = $2`,
        [city, weekStart, to],
      );
      asked++;
    }
  }
  return { asked, autoFilled };
}

// ── приём ответа ─────────────────────────────────────────────────────────────

/**
 * Ответ человека боту: самый СТАРЫЙ неотвеченный вопрос этого человека (если он
 * ответственный за два города — сообщения закрывают вопросы по очереди).
 * Возвращает null, если вопросов не было — событие не наше (Phase 2 бота).
 */
export async function recordWeatherAnswer(fromUserId: string, text: string): Promise<{ city: WeatherCity; weekStart: string } | null> {
  const clean = text.trim();
  if (!clean) return null;
  const db = systemDb();
  const res = await db.query<{ city: WeatherCity; week_start: string }>(
    `UPDATE weekly_weather SET
        manual_text = $2, manual_author_bitrix_id = $1, answered_at = now(), updated_at = now()
      WHERE id = (
        SELECT id FROM weekly_weather
         WHERE asked_bitrix_id = $1 AND answered_at IS NULL
         ORDER BY week_start ASC, city ASC LIMIT 1
      )
      RETURNING city, to_char(week_start, 'YYYY-MM-DD') AS week_start`,
    [fromUserId, clean.slice(0, 2000)],
  );
  const row = res.rows[0];
  if (!row) return null;
  await sendBitrixBotMessage(
    fromUserId,
    `Записал погоду (${WEATHER_CITIES[row.city].label}, неделя с ${fmtRu(row.week_start)}) в отчёт «Данные по годам». Спасибо!`,
    undefined,
    'report',
  );
  return { city: row.city, weekStart: row.week_start };
}

// ── чтение для отчёта ────────────────────────────────────────────────────────

export interface WeekWeatherRow {
  city: WeatherCity; weekStart: string;
  manualText: string | null;
  /** Полная сводка: «t 12…22, осадки 71 мм». */
  autoSummary: string | null;
  /** Короткая: «+5, пасмурно». */
  autoShort: string | null;
  /** Средняя температура недели, °C — ЧИСЛОМ, для графика (задача 28.08). */
  autoTemp: number | null;
  /** Средняя облачность недели, % — для подсказок графика. */
  autoCloud: number | null;
}

export async function listWeatherForYear(year: number): Promise<WeekWeatherRow[]> {
  const res = await systemDb().query<{ city: WeatherCity; week_start: string; manual_text: string | null; auto_summary: string | null; auto_short: string | null; auto_temp: string | null; auto_cloud: string | null }>(
    `SELECT city, to_char(week_start, 'YYYY-MM-DD') AS week_start, manual_text, auto_summary, auto_short,
            (auto_data->>'tMean')::numeric AS auto_temp,
            (auto_data->>'cloudPct')::numeric AS auto_cloud
       FROM weekly_weather
      WHERE week_start >= make_date($1, 1, 1) - interval '7 days'
        AND week_start < make_date($1 + 1, 1, 1)`,
    [year],
  );
  return res.rows.map(r => ({
    city: r.city, weekStart: r.week_start, manualText: r.manual_text,
    autoSummary: r.auto_summary, autoShort: r.auto_short,
    autoTemp: r.auto_temp !== null ? Number(r.auto_temp) : null,
    autoCloud: r.auto_cloud !== null ? Number(r.auto_cloud) : null,
  }));
}
