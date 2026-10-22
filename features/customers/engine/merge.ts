// «Один человек — один заказчик» (миграция 243, владелец 22.10, вариант Б; план Fable). Ключ заказчика
// (clientKey.ts) делит клиента на c<контакт> (розница), x<контакт> (юр-сделка без компании) и
// k<компания> — у Хорева это три карточки с раздельными отгрузками и потенциалом. Здесь строится карта
// «ключ-член → каноничный ключ», которую SQL снимка заказчиков (customers.ts) применяет к сделкам ДО
// агрегации: покупки, интервалы, последняя отгрузка и менеджер считаются по всем сделкам человека.
//
// Источники: автосклейка (из sa, каждый раз заново) + ручные решения РОПа (customer_merge_links):
// merge — склеить, split — «это не один человек», гасит автосклейку ключа. Флаг customer_merge
// (feature_flags) выключен → карта пустая, движок считает как раньше.
//
// Каноничный ключ стабилен (отметки, очередь, журнал пишутся по нему): ручной primary, иначе k > c > x,
// при равенстве — меньший id. Не зависит от того, какая сделка последняя.
// Остальные потребители CLIENT_KEY_CASE_SQL (XP, бейджи, квесты, кросс-селл) склейку НЕ видят —
// это начисления по сущностям Битрикса, ретроактивно их не двигаем.
import { analyticsDb, systemDb } from '@/lib/db/clients';
import { isFeatureEnabled } from '@/lib/featureFlags';

/** Компания с бо́льшим числом разных контактов в сделках — стройорг с прорабами: не клеим никого
 *  (данные 22.10: 35 901 компания с 1 контактом, 40 — с 2, 2 — с 3, больше — ни одной). */
export const MERGE_MAX_COMPANY_CONTACTS = 3;

export type MergeSource = 'auto_contact' | 'auto_company' | 'manual';
export interface AliasInfo { primary: string; source: MergeSource }
export interface ManualLink { member: string; primary: string | null; mode: 'merge' | 'split'; comment: string | null; by: string | null; at: string }

const AUTO_SQL = `
WITH d AS (
  SELECT contact_id, company_id, funnel_id, created_at FROM sa.deals WHERE funnel_id IN (0,1,2,3)
),
cx AS (
  SELECT 'x'||contact_id AS member_key, 'c'||contact_id AS primary_key
  FROM d WHERE coalesce(contact_id, 0) <> 0
  GROUP BY contact_id
  HAVING bool_or(funnel_id IN (0,2)) AND bool_or(funnel_id IN (1,3) AND coalesce(company_id, 0) = 0)
),
pairs AS (
  SELECT company_id, contact_id, count(*) AS deals, max(created_at) AS last_at
  FROM d WHERE coalesce(company_id, 0) <> 0 AND coalesce(contact_id, 0) <> 0 AND funnel_id IN (1,3)
  GROUP BY 1, 2
),
cstat AS (SELECT company_id, count(*) AS n_contacts FROM pairs GROUP BY 1),
best AS (
  SELECT DISTINCT ON (p.contact_id) p.contact_id, p.company_id
  FROM pairs p JOIN cstat s USING (company_id)
  WHERE s.n_contacts <= $1
  ORDER BY p.contact_id, p.deals DESC, p.last_at DESC
),
-- Только ключи, которые реально есть у контакта (розничные сделки → c, юр-сделки без компании → x).
own AS (
  SELECT contact_id, bool_or(funnel_id IN (0,2)) AS has_c, bool_or(funnel_id IN (1,3) AND coalesce(company_id, 0) = 0) AS has_x
  FROM d WHERE coalesce(contact_id, 0) <> 0 GROUP BY 1
)
SELECT member_key, primary_key, 'auto_contact' AS source FROM cx
UNION ALL SELECT 'c'||b.contact_id, 'k'||b.company_id, 'auto_company' FROM best b JOIN own o USING (contact_id) WHERE o.has_c
UNION ALL SELECT 'x'||b.contact_id, 'k'||b.company_id, 'auto_company' FROM best b JOIN own o USING (contact_id) WHERE o.has_x`;

export async function fetchAutoAliases(): Promise<{ member: string; primary: string; source: MergeSource }[]> {
  const r = await analyticsDb().query<{ member_key: string; primary_key: string; source: MergeSource }>(AUTO_SQL, [MERGE_MAX_COMPANY_CONTACTS]);
  return r.rows.map(x => ({ member: x.member_key, primary: x.primary_key, source: x.source }));
}

export async function fetchManualLinks(): Promise<ManualLink[]> {
  const r = await systemDb().query<{ member_key: string; primary_key: string | null; mode: 'merge' | 'split'; comment: string | null; created_by_name: string | null; created_by: string; created_at: Date }>(
    'SELECT member_key, primary_key, mode, comment, created_by_name, created_by, created_at FROM customer_merge_links ORDER BY created_at',
  ).catch(() => ({ rows: [] as never[] }));
  return r.rows.map(x => ({ member: x.member_key, primary: x.primary_key, mode: x.mode, comment: x.comment, by: x.created_by_name ?? x.created_by, at: new Date(x.created_at).toISOString() }));
}

const PREFIX_RANK: Record<string, number> = { k: 0, c: 1, x: 2 };
function canonicalOf(keys: string[], manualPrimaries: Set<string>): string {
  return [...keys].sort((a, b) =>
    Number(manualPrimaries.has(b)) - Number(manualPrimaries.has(a))
    || (PREFIX_RANK[a[0]] ?? 9) - (PREFIX_RANK[b[0]] ?? 9)
    || Number(a.slice(1)) - Number(b.slice(1)))[0];
}

/** Союз авто- и ручных связей → член → каноничный ключ (только для членов ≠ каноничного). */
export function buildAliasMap(auto: { member: string; primary: string; source: MergeSource }[], manual: ManualLink[]): Map<string, AliasInfo> {
  const split = new Set(manual.filter(m => m.mode === 'split').map(m => m.member));
  const parent = new Map<string, string>();
  const find = (k: string): string => {
    let p = parent.get(k) ?? k;
    if (p !== k) { p = find(p); parent.set(k, p); }
    return p;
  };
  const union = (a: string, b: string) => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(ra, rb); };
  const sourceOf = new Map<string, MergeSource>();
  for (const e of auto) {
    if (split.has(e.member) || split.has(e.primary)) continue;
    union(e.member, e.primary);
    if (!sourceOf.has(e.member)) sourceOf.set(e.member, e.source);
    if (!sourceOf.has(e.primary)) sourceOf.set(e.primary, e.source);
  }
  const manualPrimaries = new Set<string>();
  for (const m of manual) if (m.mode === 'merge' && m.primary) {
    union(m.member, m.primary); manualPrimaries.add(m.primary);
    sourceOf.set(m.member, 'manual'); sourceOf.set(m.primary, sourceOf.get(m.primary) ?? 'manual');
  }
  const groups = new Map<string, string[]>();
  for (const k of new Set([...parent.keys(), ...parent.values()])) {
    const r = find(k);
    const g = groups.get(r) ?? []; g.push(k); groups.set(r, g);
  }
  const out = new Map<string, AliasInfo>();
  for (const keys of groups.values()) {
    if (keys.length < 2) continue;
    const primary = canonicalOf(keys, manualPrimaries);
    for (const k of keys) if (k !== primary) out.set(k, { primary, source: sourceOf.get(k) ?? 'auto_company' });
  }
  return out;
}

let _cache: { at: number; map: Map<string, AliasInfo> } | null = null;
const TTL_MS = 5 * 60_000;
export function invalidateAliasCache(): void { _cache = null; }

/** Текущая карта склейки; флаг выключен → пустая. Кэш 5 мин (снимок считается раз в 10). */
export async function fetchAliasMap(opts: { force?: boolean } = {}): Promise<Map<string, AliasInfo>> {
  if (!(await isFeatureEnabled('customer_merge'))) return new Map();
  if (!opts.force && _cache && Date.now() - _cache.at < TTL_MS) return _cache.map;
  const [auto, manual] = await Promise.all([fetchAutoAliases(), fetchManualLinks()]);
  const map = buildAliasMap(auto, manual);
  _cache = { at: Date.now(), map };
  return map;
}

/** Массивы для SQL: unnest($a::text[], $b::text[]) AS al(member_key, primary_key). */
export function aliasArrays(map: Map<string, AliasInfo>): [string[], string[]] {
  const members: string[] = [], primaries: string[] = [];
  for (const [m, a] of map) { members.push(m); primaries.push(a.primary); }
  return [members, primaries];
}

/** Все исходные ключи заказчика по каноничному (сам ключ первым); без склейки — [clientKey]. */
export async function memberKeysOf(clientKey: string): Promise<string[]> {
  const map = await fetchAliasMap().catch(() => new Map<string, AliasInfo>());
  return [clientKey, ...[...map].filter(([, a]) => a.primary === clientKey).map(([m]) => m)];
}

/** Ручная склейка (РОП и старше): member → primary. Перекрывает прежнюю отметку member (в т.ч. split). */
export async function saveMerge(input: { memberKey: string; primaryKey: string; comment: string | null; by: { login: string; name: string | null; bitrixId: string | null } }): Promise<void> {
  await systemDb().query(
    `INSERT INTO customer_merge_links (member_key, primary_key, mode, comment, created_by, created_by_name, created_by_bitrix_id)
     VALUES ($1, $2, 'merge', $3, $4, $5, $6)
     ON CONFLICT (member_key) DO UPDATE SET primary_key = EXCLUDED.primary_key, mode = 'merge', comment = EXCLUDED.comment,
       created_by = EXCLUDED.created_by, created_by_name = EXCLUDED.created_by_name, created_by_bitrix_id = EXCLUDED.created_by_bitrix_id, created_at = now()`,
    [input.memberKey, input.primaryKey, input.comment, input.by.login, input.by.name, input.by.bitrixId],
  );
  // Каноничный ключ не должен сам висеть «членом» чужой ручной группы — иначе цикл решений.
  await systemDb().query(`DELETE FROM customer_merge_links WHERE member_key = $1 AND mode = 'merge'`, [input.primaryKey]);
  invalidateAliasCache();
}

/** Разъединить: ручную склейку — удалить; автосклейку — погасить отметкой split. */
export async function saveUnmerge(input: { memberKey: string; by: { login: string; name: string | null; bitrixId: string | null } }): Promise<'manual_removed' | 'split'> {
  const del = await systemDb().query(`DELETE FROM customer_merge_links WHERE member_key = $1 AND mode = 'merge'`, [input.memberKey]);
  invalidateAliasCache();
  // Ключ остался в группе через автосклейку (или был её каноничным) — гасим.
  const still = (await fetchAliasMap({ force: true })).has(input.memberKey);
  if (del.rowCount && !still) return 'manual_removed';
  await systemDb().query(
    `INSERT INTO customer_merge_links (member_key, primary_key, mode, created_by, created_by_name, created_by_bitrix_id)
     VALUES ($1, NULL, 'split', $2, $3, $4)
     ON CONFLICT (member_key) DO UPDATE SET primary_key = NULL, mode = 'split', comment = NULL,
       created_by = EXCLUDED.created_by, created_by_name = EXCLUDED.created_by_name, created_by_bitrix_id = EXCLUDED.created_by_bitrix_id, created_at = now()`,
    [input.memberKey, input.by.login, input.by.name, input.by.bitrixId],
  );
  invalidateAliasCache();
  return 'split';
}

/** Сводка для предпросмотра перед включением флага (admin): сколько склеится и пример Хорева. */
export async function mergePreview(): Promise<{ autoContact: number; autoCompany: number; manual: number; groups: number; members: number; sample: { primary: string; members: string[] }[] }> {
  const [auto, manual] = await Promise.all([fetchAutoAliases(), fetchManualLinks()]);
  const map = buildAliasMap(auto, manual);
  const groups = new Map<string, string[]>();
  for (const [m, a] of map) groups.set(a.primary, [...(groups.get(a.primary) ?? []), m]);
  const pick = ['k15105', 'c16076', 'x16076', 'c1492'];
  const sample = [...groups].filter(([p, ms]) => pick.includes(p) || ms.some(m => pick.includes(m)))
    .concat([...groups].filter(([, ms]) => ms.length > 1).slice(0, 10))
    .map(([primary, members]) => ({ primary, members }));
  return {
    autoContact: auto.filter(a => a.source === 'auto_contact').length,
    autoCompany: auto.filter(a => a.source === 'auto_company').length,
    manual: manual.length, groups: groups.size, members: map.size, sample,
  };
}
