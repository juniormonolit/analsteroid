// Маршрутизация: очередь по умолчанию = регион менеджера × товарная группа первой позиции (спека, «Очереди»).
// Чистые функции; справочник очередей грузит queues.ts.
import type { LogistQueue } from './contract';

const norm = (s: string) => s.toLowerCase().replace(/ё/g, 'е').replace(/[^a-zа-я0-9]+/g, ' ').trim();

/** Регион из названия проекта: «мск_Газобетон…» → МСК, «спб_…» → СПБ, «крд_…» → КРД. */
export function regionFromName(name: string): string | null {
  const m = /^(мск|спб|крд|msk|spb|krd)[_\s-]/i.exec(name.trim());
  if (!m) return null;
  const k = m[1]!.toLowerCase();
  return k === 'мск' || k === 'msk' ? 'МСК' : k === 'спб' || k === 'spb' ? 'СПБ' : 'КРД';
}

/** Насколько очередь подходит товарной группе: 2 — группа в product_groups, 1 — совпадение по словам названия. */
function groupScore(q: LogistQueue, group: string): number {
  const g = norm(group);
  if (!g) return 0;
  if (q.productGroups.some(x => norm(x) === g)) return 2;
  const title = norm(q.name.replace(/^[a-zа-я]{3}_/i, ''));
  const words = g.split(' ').filter(w => w.length >= 4);
  return words.length && words.some(w => title.includes(w.slice(0, 5))) ? 1 : 0;
}

/** Лучшая активная очередь: сперва совпадение региона, затем товарной группы (первая группа важнее). */
export function pickDefaultQueue(queues: readonly LogistQueue[], region: string | null, productGroups: readonly string[]): LogistQueue | null {
  let best: { q: LogistQueue; score: number } | null = null;
  for (const q of queues) {
    if (!q.active) continue;
    let score = 0;
    if (region && q.region === region) score += 10;
    for (let i = 0; i < Math.min(productGroups.length, 3); i++) {
      const s = groupScore(q, productGroups[i]!);
      if (s) { score += s * (3 - i); break; }
    }
    if (score > 0 && (!best || score > best.score || (score === best.score && q.sort < best.q.sort))) best = { q, score };
  }
  // только регион без группы — не угадываем: менеджер выберет сам
  return best && best.score > 10 ? best.q : best && !region ? best.q : null;
}

// ── посев очередей из Панели снабжения ─────────────────────────────────────────────────

/** Минимум из facts Панели снабжения (lib/supplyPanel/calc.ts Facts). */
export interface SupplyFactsLite {
  projects: Record<string, { name: string | null; region: string | null; dept: string | null }>;
}

export interface SeedQueue { groupId: number; name: string; region: string | null; dept: string | null }

/** Проекты Панели снабжения → очереди. Состав очереди — не отсюда, а из участников проекта Битрикса (membersFromBitrix). */
export function queuesFromSupplyFacts(f: SupplyFactsLite): SeedQueue[] {
  const out: SeedQueue[] = [];
  for (const [gid, p] of Object.entries(f.projects)) {
    const groupId = Number(gid);
    if (!Number.isInteger(groupId) || groupId <= 0 || !p.name) continue;
    out.push({ groupId, name: p.name, region: p.region ?? regionFromName(p.name), dept: p.dept });
  }
  return out.sort((a, b) => (a.region ?? '').localeCompare(b.region ?? '', 'ru') || a.name.localeCompare(b.name, 'ru'));
}

// ── состав очереди = участники проекта Битрикса (решение владельца 19.11) ──────────────

export interface BxGroupMember { USER_ID: string | number; ROLE?: string | null }
export interface BxUser { ID: string | number; NAME?: string | null; LAST_NAME?: string | null; ACTIVE?: boolean | string | null; WORK_POSITION?: string | null }
export interface SyncedMember { bitrixId: string; name: string | null; bxRole: string | null; workPosition: string | null }

/** Участники проекта → состав очереди: только активные сотрудники (уволенные — мимо), без дублей.
 *  Роль в очереди у всех 'logist': владелец/модераторы проекта (A/E) — обычно админы портала, а не руководители
 *  логистов (разведка 19.11: в проекте 13 владелец и модераторы — служебные аккаунты), поэтому в 'lead' не идут. */
export function membersFromBitrix(rows: readonly BxGroupMember[], users: ReadonlyMap<string, BxUser>): { members: SyncedMember[]; inactive: number } {
  const seen = new Map<string, SyncedMember>();
  let inactive = 0;
  for (const r of rows) {
    const id = String(r.USER_ID ?? '').trim();
    if (!/^\d{1,10}$/.test(id) || seen.has(id)) continue;
    const u = users.get(id);
    const active = u ? u.ACTIVE === true || u.ACTIVE === 'Y' || u.ACTIVE === '1' : false;
    if (!active) { inactive++; continue; }
    const name = [u!.NAME, u!.LAST_NAME].filter(x => x && String(x).trim()).join(' ').trim() || null;
    seen.set(id, { bitrixId: id, name, bxRole: r.ROLE ?? null, workPosition: u!.WORK_POSITION?.trim() || null });
  }
  return { members: [...seen.values()], inactive };
}
