// Импорт кадровых карточек из смарт-процесса Битрикса «СОТРУДНИКИ МОНОЛИТ» (entityTypeId 1054)
// в sa.employee_hr_cards (migrations/sa_org/010). Вызывается из /api/admin/org-sync после
// оргструктуры (ночной cron 04:00 МСК + кнопка) — сопоставление идёт по свежей
// sa.org_resolved_hierarchy.
//
// Зачем: стаж. В 1054 нет поля «дата найма»: «Дата начала» = дата создания карточки.
// Процесс заведён 09.12.2024, тогда же разом загружено ~140 карточек — у них дата не
// означает найм (hired_date = NULL). У остальных создание карточки ≈ найм.
// Стаж = ручная дата (sa.employee_registry) ?? hired_date (features/employees/engine/registry.ts).
//
// Сопоставление с логином — только по ФИО (в карточке нет ссылки на пользователя:
// «Ответственный» — кадровик). Ключ — первые два слова названия без учёта порядка,
// регистра и ё/е; против «Имя Фамилия» активных логинов оргструктуры. Сопоставляем
// ТОЛЬКО карточки работающих: у уволенных логин обычно уже отдан новому человеку
// (слот-модель), совпадение имени там ничего не доказывает. Ключ, под которым больше
// одной карточки или больше одного логина, — 'ambiguous', bitrix_id не ставим.
//
// ПДн не импортируем: дата рождения, документы, «Информация с найма», выходное интервью,
// IQ — в select их нет вообще.

import { analyticsDb } from '@/lib/db/clients';

const ENTITY_TYPE_ID = 1054;
const BULK_LOAD_DATE = '2024-12-09'; // массовая загрузка карточек при заведении процесса
const FIRED_STAGES = new Set(['DT1054_9:FAIL', 'DT1054_9:UC_GJQJTW']); // «Уволен», «Уволился»
const PAGE_PAUSE_MS = 300;

const UF = {
  position: 'ufCrm6_1733734924',   // Должность в компании (список)
  department: 'ufCrm6_1733735012', // Отдел (список)
  city: 'ufCrm6_1733744874',       // Город (список)
  division: 'ufCrm6_1733745053',   // Департамент (список)
} as const;

interface BxItem {
  id: number; title: string; stageId: string; begindate: string; movedTime?: string;
  [k: string]: unknown;
}

export interface HrCardsSyncResult {
  ok: true; cards: number; employed: number; matched: number; ambiguous: number;
  unmatched: number; withHireDate: number; ms: number;
}

function webhookBase(): string {
  const w = process.env.BITRIX_WEBHOOK_URL;
  if (!w) throw new Error('BITRIX_WEBHOOK_URL не задан');
  return w.replace(/\/+$/, '');
}

async function bx<T>(method: string, params: URLSearchParams): Promise<{ result: T; next?: number }> {
  const r = await fetch(`${webhookBase()}/${method}.json?${params}`);
  const d = await r.json() as { result?: T; next?: number; error?: string; error_description?: string };
  if (d.error || d.result === undefined) throw new Error(`${method}: ${d.error_description || d.error || `HTTP ${r.status}`}`);
  return { result: d.result, next: d.next };
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

export function nameKey(s: string): string | null {
  const w = s.toLowerCase().replace(/ё/g, 'е').replace(/[^a-zа-я\s-]/g, ' ').split(/\s+/).filter(Boolean);
  if (w.length < 2) return null;
  return [w[0], w[1]].sort().join(' ');
}

// Для «Имя Фамилия» из оргструктуры (бывает и «Имя Второе Фамилия») — первое + последнее.
function orgNameKey(s: string): string | null {
  const w = s.toLowerCase().replace(/ё/g, 'е').split(/\s+/).filter(Boolean);
  if (w.length < 2) return null;
  return [w[0], w[w.length - 1]].sort().join(' ');
}

export async function runHrCardsSync(): Promise<HrCardsSyncResult> {
  const t0 = Date.now();

  // Справочники: подписи вариантов списков и названия стадий.
  const fieldsResp = await bx<{ fields: Record<string, { items?: { ID: string | number; VALUE: string }[] }> }>(
    'crm.item.fields', new URLSearchParams({ entityTypeId: String(ENTITY_TYPE_ID) }),
  );
  const enumLabel = new Map<string, Map<string, string>>();
  for (const key of Object.values(UF)) {
    const items = fieldsResp.result.fields[key]?.items ?? [];
    enumLabel.set(key, new Map(items.map(i => [String(i.ID), i.VALUE])));
  }
  const stagesResp = await bx<{ STATUS_ID: string; NAME: string }[]>(
    'crm.status.list', new URLSearchParams({ 'filter[ENTITY_ID]': `DYNAMIC_${ENTITY_TYPE_ID}_STAGE_9` }),
  );
  const stageName = new Map(stagesResp.result.map(s => [s.STATUS_ID, s.NAME]));

  // Карточки — постранично по 50.
  const items: BxItem[] = [];
  let start: number | undefined = 0;
  while (start !== undefined) {
    const p = new URLSearchParams({ entityTypeId: String(ENTITY_TYPE_ID), start: String(start), 'order[id]': 'ASC' });
    for (const f of ['id', 'title', 'stageId', 'begindate', 'movedTime', ...Object.values(UF)]) p.append('select[]', f);
    const page: { result: { items: BxItem[] }; next?: number } = await bx<{ items: BxItem[] }>('crm.item.list', p);
    items.push(...page.result.items);
    start = page.next;
    if (start !== undefined) await sleep(PAGE_PAUSE_MS);
  }
  // Пустой ответ при живом процессе — почти наверняка сбой/права вебхука: не затираем таблицу.
  if (items.length === 0) throw new Error('crm.item.list 1054 вернул 0 карточек — импорт пропущен');

  const pool = analyticsDb();
  const org = await pool.query<{ id: number; name: string }>(
    `SELECT manager_bitrix_user_id::int AS id, manager_name AS name
       FROM sa.org_resolved_hierarchy WHERE is_active`,
  );
  const usersByKey = new Map<string, Set<number>>();
  for (const u of org.rows) {
    const k = orgNameKey(u.name);
    if (!k) continue;
    if (!usersByKey.has(k)) usersByKey.set(k, new Set());
    usersByKey.get(k)!.add(u.id);
  }

  const employed = (i: BxItem) => !FIRED_STAGES.has(i.stageId);
  const cardsByKey = new Map<string, number>();
  for (const i of items) {
    const k = nameKey(i.title ?? '');
    if (k && employed(i)) cardsByKey.set(k, (cardsByKey.get(k) ?? 0) + 1);
  }

  const label = (key: string, v: unknown) =>
    v === null || v === undefined || v === '' ? null : (enumLabel.get(key)?.get(String(v)) ?? null);
  const day = (s: string | undefined) => (s ? s.slice(0, 10) : null);

  const rows = items.map((i) => {
    const isEmployed = employed(i);
    const created = day(i.begindate)!;
    let bitrixId: number | null = null;
    let match: 'unique' | 'ambiguous' | 'none' = 'none';
    const k = nameKey(i.title ?? '');
    if (isEmployed && k) {
      const users = usersByKey.get(k);
      if (users && users.size === 1 && cardsByKey.get(k) === 1) { bitrixId = [...users][0]; match = 'unique'; }
      else if (users && users.size > 0) match = 'ambiguous';
    }
    return {
      item_id: i.id, title: (i.title ?? '').trim(), stage_id: i.stageId, stage_name: stageName.get(i.stageId) ?? null,
      is_employed: isEmployed, card_created: created,
      hired_date: created > BULK_LOAD_DATE ? created : null,
      fired_date: isEmployed ? null : day(i.movedTime),
      position: label(UF.position, i[UF.position]), department: label(UF.department, i[UF.department]),
      division: label(UF.division, i[UF.division]), city: label(UF.city, i[UF.city]),
      bitrix_id: bitrixId, match_status: match,
    };
  });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM sa.employee_hr_cards');
    await client.query(
      `INSERT INTO sa.employee_hr_cards (item_id, title, stage_id, stage_name, is_employed, card_created,
         hired_date, fired_date, position, department, division, city, bitrix_id, match_status, synced_at)
       SELECT * , now() FROM jsonb_to_recordset($1::jsonb) AS x(item_id int, title text, stage_id text,
         stage_name text, is_employed boolean, card_created date, hired_date date, fired_date date,
         position text, department text, division text, city text, bitrix_id int, match_status text)`,
      [JSON.stringify(rows)],
    );
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }

  const emp = rows.filter(r => r.is_employed);
  return {
    ok: true, cards: rows.length, employed: emp.length,
    matched: emp.filter(r => r.match_status === 'unique').length,
    ambiguous: emp.filter(r => r.match_status === 'ambiguous').length,
    unmatched: emp.filter(r => r.match_status === 'none').length,
    withHireDate: emp.filter(r => r.match_status === 'unique' && r.hired_date).length,
    ms: Date.now() - t0,
  };
}

// ---------- Чтение ----------

export interface HrCardInfo {
  hiredDate: string | null; position: string | null; department: string | null;
  division: string | null; city: string | null; stageName: string | null;
}

// Карточка работающего, однозначно сопоставленная с логином (если их несколько —
// самая свежая). Таблица ещё не накатана (42P01) — пустая карта, стаж как раньше.
export async function getHrCardsByBitrixId(bitrixId?: number): Promise<Map<number, HrCardInfo>> {
  try {
    const r = await analyticsDb().query<{
      bitrix_id: number; hired_date: string | null; position: string | null; department: string | null;
      division: string | null; city: string | null; stage_name: string | null;
    }>(
      `SELECT DISTINCT ON (bitrix_id) bitrix_id, to_char(hired_date, 'YYYY-MM-DD') AS hired_date,
              position, department, division, city, stage_name
         FROM sa.employee_hr_cards
        WHERE is_employed AND match_status = 'unique' AND bitrix_id IS NOT NULL
          AND ($1::int IS NULL OR bitrix_id = $1::int)
        ORDER BY bitrix_id, card_created DESC, item_id DESC`,
      [bitrixId ?? null],
    );
    return new Map(r.rows.map(x => [x.bitrix_id, {
      hiredDate: x.hired_date, position: x.position, department: x.department,
      division: x.division, city: x.city, stageName: x.stage_name,
    }]));
  } catch (e) {
    if ((e as { code?: string }).code === '42P01') return new Map();
    throw e;
  }
}
