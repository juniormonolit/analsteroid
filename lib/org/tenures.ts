// Периоды «логин Битрикса → человек» (sa.employee_tenures, migrations/sa_org/010) —
// таймлайн раздела «Сотрудники» и база стажа. Решение владельца 18.11: «зафиксировать
// сейчас всех действующих», на таймлайне видно, какое ФИО на логине когда сидело;
// правят админы и носители section.employees_edit (карточка сотрудника).
//
// reconcileTenures() — идемпотентная сверка с оргструктурой, вызывается ночным
// org-sync и при первом открытии таймлайна (пустая таблица):
//  * у логина нет ни одного периода → фиксация: прошлые имена из
//    sa.employee_name_history (закрытые строки) + открытый период текущего человека.
//    Дата начала текущего: ручная (sa.employee_registry) → дата найма из карточки 1054 →
//    valid_from текущего имени, если на логине было переименование (первая строка истории
//    — затравка org-sync 13.07.2026, а не найм; её дата = «неизвестно»);
//  * открытый период есть, а имя на логине в Битриксе сменилось (сравниваем с bx_name —
//    именем при открытии, НЕ с person_name: ручная правка ФИО — не новый человек) →
//    закрываем его датой смены имени, открываем новый (source 'rename');
//  * все периоды закрыты руками, а имя в Битриксе прежнее — логин свободен, не трогаем;
//  * логин стал неактивным в Битриксе → открытый период закрываем сегодняшним днём.
// Руками заведённое/исправленное сверка не трогает — только закрывает при смене имени.

import type { PoolClient } from 'pg';
import { analyticsDb } from '@/lib/db/clients';

export type TenureSource = 'snapshot' | 'rename' | 'manual' | 'hr_card';

export interface Tenure {
  id: number; bitrixId: number; personName: string;
  startDate: string | null; endDate: string | null;
  position: string | null; hrItemId: number | null; source: TenureSource;
  updatedBy: string | null; updatedAt: string | null;
}

export function normName(s: string): string {
  return s.toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim();
}

// Логин без человека: Битрикс между людьми переименовывает его в заглушку —
// «Manager106», «User 1891», латинский логин. Без кириллицы = никого нет.
export function isPlaceholderName(name: string): boolean {
  return !/[а-яё]/i.test(name) || /^user\s*\d+$/i.test(name.trim());
}

interface HistRow { name: string; vf: string; vt: string | null }
interface Segment { name: string; start: string | null; end: string | null }

// История имён логина → периоды людей. Первая запись истории — затравка org-sync
// 13.07.2026 (начало неизвестно). Склейку разрывает только другой человек.
export function historySegments(h: HistRow[]): Segment[] {
  const out: Segment[] = [];
  h.forEach((row, i) => {
    if (isPlaceholderName(row.name)) return;
    const last = out[out.length - 1];
    // Тот же человек снова, а между — никого (только заглушка) — один период.
    if (last && samePerson(last.name, row.name)) {
      last.end = row.vt;
      if (!hasStatusMark(row.name)) last.name = row.name; // имя без пометки «В ОТПУСКЕ» и т.п.
    } else {
      out.push({ name: row.name, start: i === 0 ? null : row.vf, end: row.vt });
    }
  });
  return out;
}

// С какой даты на логине текущее имя (открытая строка истории), иначе — сегодня.
function sinceOf(h: HistRow[], name: string, today: string): string {
  const open = h.length ? h[h.length - 1] : null;
  return open && !open.vt && normName(open.name) === normName(name) ? open.vf : today;
}

// «Иванов Иван Сергеевич» ≈ «Иван Иванов»: фамилия и имя совпадают без учёта порядка.
// Слова ЗАГЛАВНЫМИ — пометки в Битриксе («В ОТПУСКЕ Романова», «УДАЛИТЬ», «РОП МСК»),
// не часть ФИО: при сравнении людей их не учитываем.
const personWords = (s: string) => s.trim().split(/\s+/).filter(w => !/^[А-ЯЁA-Z]+$/.test(w)).map(w => normName(w));
export const hasStatusMark = (s: string) => personWords(s).length !== s.trim().split(/\s+/).length;

export function samePerson(a: string, b: string): boolean {
  const wa = personWords(a), wb = personWords(b);
  if (!wa.length || !wb.length) return false;
  const [short, long] = wa.length <= wb.length ? [wa, new Set(wb)] : [wb, new Set(wa)];
  return short.every(w => long.has(w));
}

const todayMsk = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Moscow' });

function isMissingTable(e: unknown): boolean {
  return (e as { code?: string }).code === '42P01';
}

const TENURE_COLS = `id, bitrix_id, person_name,
  to_char(start_date, 'YYYY-MM-DD') AS start_date, to_char(end_date, 'YYYY-MM-DD') AS end_date,
  position, hr_item_id, source, updated_by,
  to_char(updated_at AT TIME ZONE 'Europe/Moscow', 'YYYY-MM-DD HH24:MI') AS updated_at`;

interface TenureRow {
  id: number; bitrix_id: number; person_name: string; start_date: string | null; end_date: string | null;
  position: string | null; hr_item_id: number | null; source: TenureSource; updated_by: string | null; updated_at: string | null;
}

const toTenure = (r: TenureRow): Tenure => ({
  id: r.id, bitrixId: r.bitrix_id, personName: r.person_name, startDate: r.start_date, endDate: r.end_date,
  position: r.position, hrItemId: r.hr_item_id, source: r.source, updatedBy: r.updated_by, updatedAt: r.updated_at,
});

/** Все периоды (или одного логина), по логину и дате начала. До наката миграции — []. */
export async function listTenures(bitrixId?: number): Promise<Tenure[]> {
  try {
    const r = await analyticsDb().query<TenureRow>(
      `SELECT ${TENURE_COLS} FROM sa.employee_tenures
        WHERE ($1::int IS NULL OR bitrix_id = $1::int)
        ORDER BY bitrix_id, start_date NULLS FIRST, id`,
      [bitrixId ?? null],
    );
    return r.rows.map(toTenure);
  } catch (e) {
    if (isMissingTable(e)) return [];
    throw e;
  }
}

export async function countTenures(): Promise<number | null> {
  try {
    const r = await analyticsDb().query<{ n: string }>('SELECT count(*) AS n FROM sa.employee_tenures');
    return Number(r.rows[0].n);
  } catch (e) {
    if (isMissingTable(e)) return null; // таблицы нет — миграция не накатана
    throw e;
  }
}

export interface ReconcileResult { seeded: number; renamed: number; closedInactive: number }

export async function reconcileTenures(): Promise<ReconcileResult> {
  const pool = analyticsDb();
  const [org, hist, open, has, reg, hr] = await Promise.all([
    pool.query<{ id: number; name: string; is_active: boolean }>(
      `SELECT manager_bitrix_user_id::int AS id, manager_name AS name, is_active FROM sa.org_resolved_hierarchy`),
    pool.query<{ uid: number; name: string; vf: string; vt: string | null }>(
      `SELECT bitrix_user_id::int AS uid, name,
              to_char(valid_from AT TIME ZONE 'Europe/Moscow', 'YYYY-MM-DD') AS vf,
              to_char(valid_to AT TIME ZONE 'Europe/Moscow', 'YYYY-MM-DD') AS vt
         FROM sa.employee_name_history ORDER BY valid_from, id`),
    pool.query<{ id: number; bitrix_id: number; person_name: string; bx_name: string | null }>(
      `SELECT id, bitrix_id, person_name, bx_name FROM sa.employee_tenures WHERE end_date IS NULL`),
    // Последний закрытый период логина — чтобы не открывать заново человека, которого
    // уволили руками, пока в Битриксе на логине ещё его имя.
    pool.query<{ bitrix_id: number; bx_name: string | null; person_name: string }>(
      `SELECT DISTINCT ON (bitrix_id) bitrix_id, bx_name, person_name FROM sa.employee_tenures
        ORDER BY bitrix_id, end_date DESC NULLS FIRST, id DESC`),
    pool.query<{ bitrix_id: number; d: string }>(
      `SELECT bitrix_id, to_char(manual_start_date, 'YYYY-MM-DD') AS d FROM sa.employee_registry WHERE manual_start_date IS NOT NULL`),
    pool.query<{ bitrix_id: number; item_id: number; hired: string | null; position: string | null }>(
      `SELECT DISTINCT ON (bitrix_id) bitrix_id, item_id, to_char(hired_date, 'YYYY-MM-DD') AS hired, position
         FROM sa.employee_hr_cards
        WHERE is_employed AND match_status = 'unique' AND bitrix_id IS NOT NULL
          AND item_id NOT IN (SELECT hr_item_id FROM sa.employee_tenures WHERE hr_item_id IS NOT NULL)
        ORDER BY bitrix_id, card_created DESC, item_id DESC`).catch((e) => {
      if (isMissingTable(e)) return { rows: [] as { bitrix_id: number; item_id: number; hired: string | null; position: string | null }[] };
      throw e;
    }),
  ]);

  const histBy = new Map<number, { name: string; vf: string; vt: string | null }[]>();
  for (const h of hist.rows) {
    if (!histBy.has(h.uid)) histBy.set(h.uid, []);
    histBy.get(h.uid)!.push(h);
  }
  const openBy = new Map(open.rows.map(o => [o.bitrix_id, o]));
  const lastBy = new Map(has.rows.map(r => [r.bitrix_id, r]));
  const manual = new Map(reg.rows.map(r => [r.bitrix_id, r.d]));
  const hrBy = new Map(hr.rows.map(r => [r.bitrix_id, r]));
  const today = todayMsk();
  const res: ReconcileResult = { seeded: 0, renamed: 0, closedInactive: 0 };

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const u of org.rows) {
      const h = histBy.get(u.id) ?? [];
      const cur = openBy.get(u.id);

      if (!u.is_active) {
        if (cur) {
          await client.query(
            `UPDATE sa.employee_tenures SET end_date = GREATEST(coalesce(start_date, $2::date), $2::date),
                    updated_by = 'org-sync', updated_at = now() WHERE id = $1`, [cur.id, today]);
          res.closedInactive++;
        }
        continue;
      }

      if (!lastBy.has(u.id)) {
        // Фиксация логина: история имён → периоды людей (заглушки — «логин свободен»,
        // подряд идущие записи одного человека склеиваются) + текущий человек.
        const segs = historySegments(h);
        for (const s of segs) {
          if (s.end === null) continue;
          await insertTenure(client, {
            bitrixId: u.id, personName: s.name, bxName: s.name, startDate: s.start, endDate: s.end,
            position: null, hrItemId: null, source: 'rename', by: 'org-sync',
          });
        }
        if (!isPlaceholderName(u.name)) {
          const openSeg = segs.find(s => s.end === null);
          const segStart = openSeg?.start ?? null;
          // Ручная дата/дата карточки раньше прихода человека на логин — от предшественника
          // (ручная) или найм до этого логина; для периода на логине берём дату прихода.
          const fits = (d: string | null | undefined) => (d && (!segStart || d >= segStart) ? d : null);
          const card = hrBy.get(u.id);
          await insertTenure(client, {
            bitrixId: u.id, personName: u.name, bxName: u.name,
            startDate: fits(card?.hired) ?? fits(manual.get(u.id)) ?? segStart,
            endDate: null, position: card?.position ?? null, hrItemId: card?.item_id ?? null,
            source: 'snapshot', by: 'org-sync',
          });
        }
        res.seeded++;
        continue;
      }

      if (cur && cur.bx_name === null) {
        // Период заведён руками — запоминаем, под каким именем логин сейчас в Битриксе.
        await client.query('UPDATE sa.employee_tenures SET bx_name = $2 WHERE id = $1', [cur.id, u.name]);
      } else if (cur && normName(cur.bx_name!) !== normName(u.name) && samePerson(cur.person_name, u.name)) {
        // Человека завели руками раньше, чем Битрикс переименовал логин, — это он и есть.
        await client.query('UPDATE sa.employee_tenures SET bx_name = $2 WHERE id = $1', [cur.id, u.name]);
      } else if (cur && normName(cur.bx_name!) !== normName(u.name)) {
        // На логине сменилось имя → человек ушёл; если новое имя не заглушка — пришёл новый.
        // Дата смены — из истории org-sync.
        const since = sinceOf(h, u.name, today);
        await client.query(
          `UPDATE sa.employee_tenures SET end_date = GREATEST(coalesce(start_date, $2::date), $2::date),
                  updated_by = 'org-sync', updated_at = now() WHERE id = $1`, [cur.id, since]);
        if (!isPlaceholderName(u.name)) {
          await insertTenure(client, {
            bitrixId: u.id, personName: u.name, bxName: u.name, startDate: since, endDate: null,
            position: null, hrItemId: null, source: 'rename', by: 'org-sync',
          });
        }
        res.renamed++;
      } else if (!cur) {
        // Открытого периода нет (логин свободен или уволили руками). Заглушка или прежнее
        // имя в Битриксе — ничего не открываем. Новое настоящее имя — сел новый человек.
        if (isPlaceholderName(u.name)) continue;
        const last = lastBy.get(u.id)!;
        if (normName(last.bx_name ?? last.person_name) === normName(u.name)) continue;
        await insertTenure(client, {
          bitrixId: u.id, personName: u.name, bxName: u.name, startDate: sinceOf(h, u.name, today), endDate: null,
          position: null, hrItemId: null, source: 'snapshot', by: 'org-sync',
        });
        res.seeded++;
      }
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
  return res;
}

interface NewTenure {
  bitrixId: number; personName: string; bxName?: string | null; startDate: string | null; endDate: string | null;
  position: string | null; hrItemId: number | null; source: TenureSource; by: string;
}

async function insertTenure(client: PoolClient, t: NewTenure): Promise<number> {
  const r = await client.query<{ id: number }>(
    `INSERT INTO sa.employee_tenures (bitrix_id, person_name, bx_name, start_date, end_date, position, hr_item_id, source, updated_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
    [t.bitrixId, t.personName, t.bxName ?? null, t.startDate, t.endDate, t.position, t.hrItemId, t.source, t.by],
  );
  return r.rows[0].id;
}

// ---------- Ручная правка (карточка сотрудника) ----------

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export interface TenureInput {
  personName: string; startDate: string | null; endDate: string | null; position: string | null;
}

/** Ошибка валидации или null. existing — периоды того же логина (без редактируемого). */
export function validateTenure(t: TenureInput, existing: Pick<Tenure, 'id' | 'startDate' | 'endDate' | 'personName'>[]): string | null {
  if (!t.personName.trim()) return 'Укажите ФИО';
  if (t.personName.length > 200) return 'Слишком длинное ФИО';
  const today = todayMsk();
  for (const [label, d] of [['начала', t.startDate], ['увольнения', t.endDate]] as const) {
    if (d === null) continue;
    if (!DATE_RE.test(d) || Number.isNaN(new Date(`${d}T00:00:00Z`).getTime())) return `Некорректная дата ${label}`;
    if (d < '1990-01-01') return `Слишком ранняя дата ${label}`;
    if (d > today) return `Дата ${label} не может быть в будущем`;
  }
  if (t.startDate && t.endDate && t.endDate < t.startDate) return 'Дата увольнения раньше даты начала';
  if (t.endDate === null && existing.some(e => e.endDate === null)) {
    const who = existing.find(e => e.endDate === null)!.personName;
    return `На логине уже числится «${who}» без даты увольнения — сначала закройте его период`;
  }
  // Пересечения: открытые концы — до сегодня, неизвестное начало — не проверяем.
  const s = t.startDate, e = t.endDate ?? today;
  if (s) {
    for (const x of existing) {
      if (!x.startDate) continue;
      const xe = x.endDate ?? today;
      if (s < xe && x.startDate < e) return `Период пересекается с «${x.personName}» (${x.startDate} — ${x.endDate ?? 'сейчас'})`;
    }
  }
  return null;
}

export async function createTenure(bitrixId: number, t: TenureInput & { hrItemId?: number | null }, by: string): Promise<number> {
  const client = await analyticsDb().connect();
  try {
    return await insertTenure(client, {
      bitrixId, personName: t.personName.trim(), startDate: t.startDate, endDate: t.endDate,
      position: t.position?.trim() || null, hrItemId: t.hrItemId ?? null,
      source: t.hrItemId ? 'hr_card' : 'manual', by,
    });
  } finally {
    client.release();
  }
}

export async function updateTenure(id: number, t: TenureInput, by: string): Promise<void> {
  const pool = analyticsDb();
  await pool.query(
    `UPDATE sa.employee_tenures SET person_name = $2, start_date = $3, end_date = $4, position = $5,
            updated_by = $6, updated_at = now() WHERE id = $1`,
    [id, t.personName.trim(), t.startDate, t.endDate, t.position?.trim() || null, by],
  );
  // Стаж текущего человека раньше жил в ручной дате реестра — держим её в согласии,
  // чтобы старая таблица «Сотрудники» и XP видели то же самое.
  const r = await pool.query<{ bitrix_id: number; end_date: string | null }>(
    'SELECT bitrix_id, end_date FROM sa.employee_tenures WHERE id = $1', [id]);
  if (r.rows[0] && r.rows[0].end_date === null) {
    await pool.query(
      `INSERT INTO sa.employee_registry (bitrix_id, manual_start_date, updated_by, updated_at)
       VALUES ($1, $2, $3, now())
       ON CONFLICT (bitrix_id) DO UPDATE SET manual_start_date = EXCLUDED.manual_start_date,
         updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [r.rows[0].bitrix_id, t.startDate, by],
    );
  }
}

export async function deleteTenure(id: number): Promise<void> {
  await analyticsDb().query('DELETE FROM sa.employee_tenures WHERE id = $1', [id]);
}

export async function getTenure(id: number): Promise<Tenure | null> {
  const r = await analyticsDb().query<TenureRow>(`SELECT ${TENURE_COLS} FROM sa.employee_tenures WHERE id = $1`, [id]);
  return r.rows[0] ? toTenure(r.rows[0]) : null;
}

/** Синхронизация из старой таблицы: ручная дата реестра → начало открытого периода. */
export async function syncOpenTenureStart(bitrixId: number, startDate: string | null, by: string): Promise<void> {
  try {
    await analyticsDb().query(
      `UPDATE sa.employee_tenures SET start_date = $2, updated_by = $3, updated_at = now()
        WHERE bitrix_id = $1 AND end_date IS NULL AND ($2::date IS NULL OR $2::date <= current_date)`,
      [bitrixId, startDate, by],
    );
  } catch (e) {
    if (!isMissingTable(e)) throw e;
  }
}

// ---------- Карточки 1054 для привязки ----------

export interface HrCandidate {
  itemId: number; title: string; stageName: string | null; isEmployed: boolean;
  hiredDate: string | null; cardCreated: string; firedDate: string | null; position: string | null;
}

/** Карточки 1054, ещё не привязанные ни к одному периоду. */
export async function listUnlinkedHrCards(): Promise<HrCandidate[]> {
  try {
    const r = await analyticsDb().query<{
      item_id: number; title: string; stage_name: string | null; is_employed: boolean;
      hired: string | null; created: string; fired: string | null; position: string | null;
    }>(
      `SELECT c.item_id, c.title, c.stage_name, c.is_employed,
              to_char(c.hired_date, 'YYYY-MM-DD') AS hired, to_char(c.card_created, 'YYYY-MM-DD') AS created,
              to_char(c.fired_date, 'YYYY-MM-DD') AS fired, c.position
         FROM sa.employee_hr_cards c
        WHERE NOT EXISTS (SELECT 1 FROM sa.employee_tenures t WHERE t.hr_item_id = c.item_id)
        ORDER BY c.title`,
    );
    return r.rows.map(x => ({
      itemId: x.item_id, title: x.title, stageName: x.stage_name, isEmployed: x.is_employed,
      hiredDate: x.hired, cardCreated: x.created, firedDate: x.fired, position: x.position,
    }));
  } catch (e) {
    if (isMissingTable(e)) return [];
    throw e;
  }
}

export async function getHrCard(itemId: number): Promise<HrCandidate | null> {
  const all = await analyticsDb().query<{
    item_id: number; title: string; stage_name: string | null; is_employed: boolean;
    hired: string | null; created: string; fired: string | null; position: string | null;
  }>(
    `SELECT item_id, title, stage_name, is_employed, to_char(hired_date, 'YYYY-MM-DD') AS hired,
            to_char(card_created, 'YYYY-MM-DD') AS created, to_char(fired_date, 'YYYY-MM-DD') AS fired, position
       FROM sa.employee_hr_cards WHERE item_id = $1`, [itemId]);
  const x = all.rows[0];
  return x ? {
    itemId: x.item_id, title: x.title, stageName: x.stage_name, isEmployed: x.is_employed,
    hiredDate: x.hired, cardCreated: x.created, firedDate: x.fired, position: x.position,
  } : null;
}

/** Дата начала текущего человека на логине: открытый период → ручная дата → карточка 1054. */
export async function currentStartDate(bitrixId: number): Promise<string | null> {
  const pool = analyticsDb();
  const open = await pool.query<{ d: string | null }>(
    `SELECT to_char(start_date, 'YYYY-MM-DD') AS d FROM sa.employee_tenures WHERE bitrix_id = $1 AND end_date IS NULL`,
    [bitrixId],
  ).catch((e) => { if (isMissingTable(e)) return { rows: [] as { d: string | null }[] }; throw e; });
  return open.rows[0]?.d ?? null;
}
