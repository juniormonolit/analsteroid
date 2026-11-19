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

/** Минимум из facts Панели снабжения (lib/supplyPanel/calc.ts Facts), чтобы не тянуть весь тип. */
export interface SupplyFactsLite {
  projects: Record<string, { name: string | null; region: string | null; dept: string | null }>;
  users: Record<string, string | null>;
  non_suppliers: number[];
  tasks: { g: number | null; cycles: { done: string | null; by: number | null; who?: string }[] }[];
}

export interface SeedQueue {
  groupId: number; name: string; region: string | null; dept: string | null;
  /** кто отвечал в проекте за последние sinceDays дней (≥ minAnswers ответов) — кандидаты в участники */
  members: { bitrixId: string; name: string | null; answers: number }[];
}

/** Проекты Панели снабжения → очереди. Участники — по фактическим ответам (не «снабженцы-не-снабженцы»). */
export function queuesFromSupplyFacts(f: SupplyFactsLite, now: Date, opts: { sinceDays?: number; minAnswers?: number } = {}): SeedQueue[] {
  const since = new Date(now.getTime() - (opts.sinceDays ?? 60) * 86_400_000).toISOString().slice(0, 10);
  const minAnswers = opts.minAnswers ?? 3;
  const non = new Set(f.non_suppliers.map(String));
  const answers = new Map<number, Map<string, { n: number; who: string | null }>>();
  for (const t of f.tasks) {
    if (t.g === null) continue;
    for (const c of t.cycles) {
      if (!c.by || !c.done || c.done.slice(0, 10) < since) continue;
      const uid = String(c.by);
      if (non.has(uid)) continue;
      let m = answers.get(t.g);
      if (!m) answers.set(t.g, m = new Map());
      const cur = m.get(uid) ?? { n: 0, who: null };
      cur.n++; cur.who = c.who ?? cur.who;
      m.set(uid, cur);
    }
  }
  const out: SeedQueue[] = [];
  for (const [gid, p] of Object.entries(f.projects)) {
    const groupId = Number(gid);
    if (!Number.isInteger(groupId) || groupId <= 0 || !p.name) continue;
    const members = [...(answers.get(groupId) ?? new Map()).entries()]
      .filter(([, v]) => v.n >= minAnswers)
      .map(([bitrixId, v]) => ({ bitrixId, name: v.who ?? f.users[bitrixId] ?? null, answers: v.n }))
      .sort((a, b) => b.answers - a.answers);
    out.push({ groupId, name: p.name, region: p.region ?? regionFromName(p.name), dept: p.dept, members });
  }
  return out.sort((a, b) => (a.region ?? '').localeCompare(b.region ?? '', 'ru') || a.name.localeCompare(b.name, 'ru'));
}
