import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { getCachedPlanSummary, type PlanSummary } from '@/lib/jobs/planSummary';
import { getSessionScope, scopeForbidden } from '@/lib/org/sessionScope';
import { loadScopeCoverage, type ScopeCoverage } from '@/lib/org/scopeCoverage';

type BranchMetrics = PlanSummary['branches'][number];

// Аудит 09.09: один глобальный кэш «план/факт по филиалам и отделам» (джоба раз в
// 10 мин) отдавался любой сессии. Кэш не трогаем (его же читает легаси
// /api/widget-metrics/plan) — режем на ВЫДАЧЕ по срезу сессии
// (lib/org/sessionScope.ts + lib/org/scopeCoverage.ts):
//   * админ — как раньше, весь ответ;
//   * без отделов (МОП/«Пользователь») — 403;
//   * РОП/Директор — филиал целиком, если срез покрывает все его отделы; иначе
//     только категории (ОС/НЦ/…), покрытые целиком, а цифры филиала и «Россия»
//     пересчитываются как сумма показанного — ни одного числа сверх среза.
// Форма ответа прежняя (russia + branches[].departments[]).

function pct(numerator: number, denominator: number | null): number | null {
  if (denominator === null || denominator === 0) return null;
  return Math.round((numerator / denominator) * 10000) / 100;
}

function sumNullable(values: (number | null)[]): number | null {
  const present = values.filter((v): v is number => v !== null);
  return present.length ? present.reduce((a, b) => a + b, 0) : null;
}

function aggregate(name: string, items: BranchMetrics[], departments?: BranchMetrics[]): BranchMetrics {
  const fact = items.reduce((a, b) => a + b.fact_ytd, 0);
  const targetYear = sumNullable(items.map(i => i.target_year));
  const targetToDate = sumNullable(items.map(i => i.target_to_date));
  const out: BranchMetrics = {
    name,
    fact_ytd: fact,
    target_year: targetYear,
    target_to_date: targetToDate,
    plan_percent_cumulative: pct(fact, targetYear),
    plan_percent_pace: pct(fact, targetToDate),
  };
  if (departments) out.departments = departments;
  return out;
}

function restrictToScope(summary: PlanSummary, coverage: ScopeCoverage): PlanSummary {
  const branches: BranchMetrics[] = [];
  for (const b of summary.branches) {
    if (coverage.branches.has(b.name)) { branches.push(b); continue; }
    const cats = (b.departments ?? []).filter(d => coverage.categories.has(`${b.name}:${d.name}`));
    if (cats.length === 0) continue;
    branches.push(aggregate(b.name, cats, cats));
  }
  const label = branches.length === 1 ? branches[0].name : branches.length ? 'Ваши филиалы' : 'Нет данных';
  return { updated_at: summary.updated_at, russia: aggregate(label, branches), branches };
}

export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const scope = await getSessionScope(session);
  if (scope.kind === 'self') return scopeForbidden('План/факт по филиалам доступен только руководителям отделов');

  const summary = await getCachedPlanSummary();
  if (!summary) {
    return NextResponse.json({ error: 'Данные ещё не рассчитаны или устарели' }, { status: 503 });
  }
  if (scope.kind === 'all') return NextResponse.json(summary);

  const coverage = await loadScopeCoverage(scope);
  return NextResponse.json(coverage ? restrictToScope(summary, coverage) : summary);
}
