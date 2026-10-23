// Сводка по менеджерам из отчётов ИИ-анализа (этап 2). Берём ПОСЛЕДНИЙ готовый отчёт по каждому
// заказчику за период (повторные анализы того же заказчика не умножают вес), группируем по
// основному менеджеру (больше всего расшифрованных разговоров в анализе, worker.ts:mainManagerOf).
// Критерий: доля «да» среди применимых (частично = 0,5, «неприменимо» не считается).
import { systemDb } from '@/lib/db/clients';
import { VIOLATION_LABELS, type CriterionVerdict, type ParsedReport, type ViolationKind } from './parse';

/** Только действующие виды: в старых отчётах есть убранные 23.10 (payment, not_monolit). */
const known = (v: string[] | undefined): ViolationKind[] => (v ?? []).filter((k): k is ViolationKind => k in VIOLATION_LABELS);

export interface SummaryItem { id: number; clientRef: string; createdAt: string; score: number | null; violations: ViolationKind[] }
export interface ManagerSummary {
  manager: string;
  analyses: number;
  avgScore: number | null;
  /** 8 значений 0..1 или null (не было применимых). */
  criteria: (number | null)[];
  violations: Partial<Record<ViolationKind, number>>;
  items: SummaryItem[];
}

const WEIGHT: Record<CriterionVerdict, number | null> = { yes: 1, partial: 0.5, no: 0, na: null };

export async function managerSummary(days: number): Promise<{ managers: ManagerSummary[]; total: number; noManager: number }> {
  const r = await systemDb().query<{ id: string; client_ref: string; main_manager: string | null; parsed: ParsedReport; score: string | null; created_at: Date }>(
    `SELECT DISTINCT ON (client_ref) id, client_ref, main_manager, parsed, score::text AS score, created_at
       FROM ai_analyses
      WHERE status = 'done' AND NOT is_test AND kind = 'client' AND parsed IS NOT NULL AND created_at >= now() - make_interval(days => $1)
      ORDER BY client_ref, created_at DESC`,
    [days],
  );
  const by = new Map<string, { items: SummaryItem[]; crit: { sum: number; n: number }[]; scores: number[]; viol: Partial<Record<ViolationKind, number>> }>();
  let noManager = 0;
  for (const row of r.rows) {
    if (!row.main_manager) { noManager++; continue; }
    let m = by.get(row.main_manager);
    if (!m) { m = { items: [], crit: Array.from({ length: 8 }, () => ({ sum: 0, n: 0 })), scores: [], viol: {} }; by.set(row.main_manager, m); }
    const p = row.parsed;
    (p.criteria ?? []).forEach((v, i) => {
      const w = v ? WEIGHT[v] : null;
      if (w !== null && i < 8) { m!.crit[i].sum += w; m!.crit[i].n++; }
    });
    const score = row.score === null ? null : Number(row.score);
    if (score !== null) m.scores.push(score);
    const viol = known(p.violations);
    for (const k of viol) m.viol[k] = (m.viol[k] ?? 0) + 1;
    m.items.push({ id: Number(row.id), clientRef: row.client_ref, createdAt: new Date(row.created_at).toISOString(), score, violations: viol });
  }
  const managers = [...by].map(([manager, m]) => ({
    manager,
    analyses: m.items.length,
    avgScore: m.scores.length ? m.scores.reduce((a, b) => a + b, 0) / m.scores.length : null,
    criteria: m.crit.map(c => (c.n ? c.sum / c.n : null)),
    violations: m.viol,
    items: m.items.sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
  })).sort((a, b) => b.analyses - a.analyses || (a.avgScore ?? 1) - (b.avgScore ?? 1));
  return { managers, total: r.rows.length, noManager };
}
