import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { resolveSummaryScope, parseBranchParam } from '@/lib/summary/scope';
import { defaultPeriod, toSqlInterval } from '@/lib/period';
import { fetchStageConversions, STAGE_GROUPS, STAGE_PAIRS, type StageConversionRow } from '@/features/reports/engine/stageConversions';
import { cached, reportTtl } from '@/lib/cache/redis';

// Порядок стадий воронки new→shipped (8 групп, тот же STAGE_GROUPS, что и в
// движке). Проценты — КАСКАДНОЕ произведение честных pairwise-CR (num/denom
// каждой соседней пары), т.е. ТЕ ЖЕ числа, что метрики каталога cr_stage_X_to_Y
// (см. enrichManagerRows.ts) — здесь просто перемножены по цепочке до 100% на
// старте («Лид»), чтобы получить кумулятивную воронку для графика. Отдельного
// понятия конверсии не вводится.
const STAGE_ORDER: (keyof typeof STAGE_GROUPS)[] = [
  'new', 'taken', 'contacted', 'priced', 'reservation', 'confirmed', 'sale', 'shipped',
];
const STAGE_LABELS: Record<string, string> = {
  new: 'Лид', taken: 'Взято в работу', contacted: 'Контакт', priced: 'Цена озвучена',
  reservation: 'Бронь', confirmed: 'Подтверждена', sale: 'Продажа', shipped: 'Отгружено',
};
// group(i) -> id пары "group(i-1) → group(i)" (из STAGE_PAIRS движка)
const TRANSITION_PAIR_ID: Record<string, string> = {};
for (let i = 1; i < STAGE_ORDER.length; i++) {
  const from = STAGE_ORDER[i - 1];
  const to = STAGE_ORDER[i];
  const pair = STAGE_PAIRS.find(p => p.from === from && p.to === to);
  if (pair) TRANSITION_PAIR_ID[to] = pair.id;
}

export interface FunnelStage { key: string; label: string; count: number; pct: number }

export interface SummaryFunnelResponse {
  hasAccess: boolean;
  stages: FunnelStage[];
  periodFrom: string;
  periodTo: string;
  dataAvailable: boolean; // false, если период целиком раньше DEAL_EVENTS_DATA_START
}

export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const branch = parseBranchParam(req.nextUrl.searchParams.get('branch'));
  const scope = await resolveSummaryScope(session, branch);

  // Решение владельца (бриф 1704, п.1): «с начала текущего месяца по вчера (МСК)» —
  // тот же defaultPeriod(), что и остальное приложение, не дублируем формулу.
  const period = defaultPeriod();
  const { toExcl } = toSqlInterval(period);
  const periodFrom = period.from.toISOString();
  const periodTo = period.to.toISOString();

  if (!scope.hasAccess) {
    const empty: SummaryFunnelResponse = { hasAccess: false, stages: [], periodFrom, periodTo, dataAvailable: true };
    return NextResponse.json(empty);
  }

  // stageConversions.ts не кэширует сама (два тяжёлых запроса по deal_events,
  // документированы как ~1.4с) — компанейский (unscoped) результат кэшируем сами,
  // фильтрация по managerIds — после чтения кэша (тот же приём, что и
  // buildTeamRoster/buildDepartmentCard для company-wide пула).
  const dayKey = periodFrom.slice(0, 10);
  const convObj = await cached(`summary:funnel:${dayKey}`, reportTtl(toExcl), async () => {
    const map = await fetchStageConversions(period);
    return map ? (Object.fromEntries(map) as Record<string, StageConversionRow>) : null;
  });

  if (!convObj) {
    return NextResponse.json({ hasAccess: true, stages: [], periodFrom, periodTo, dataAvailable: false } satisfies SummaryFunnelResponse);
  }

  const denom: Record<string, number> = {};
  const num: Record<string, number> = {};
  for (const [managerId, row] of Object.entries(convObj)) {
    if (!scope.managerIds.has(managerId)) continue;
    for (const [g, c] of Object.entries(row.denom)) denom[g] = (denom[g] ?? 0) + c;
    for (const [p, c] of Object.entries(row.num)) num[p] = (num[p] ?? 0) + c;
  }

  const stages: FunnelStage[] = [];
  let exactPct = 100; // не округляем между шагами — иначе погрешность накапливается
  let count = denom['new'] ?? 0;
  stages.push({ key: 'new', label: STAGE_LABELS.new, count, pct: 100 });
  for (let i = 1; i < STAGE_ORDER.length; i++) {
    const g = STAGE_ORDER[i];
    const prevG = STAGE_ORDER[i - 1];
    const pairId = TRANSITION_PAIR_ID[g];
    const prevDenom = denom[prevG] ?? 0;
    const numerator = pairId ? (num[pairId] ?? 0) : 0;
    const stepRatio = prevDenom > 0 ? numerator / prevDenom : 0;
    exactPct = exactPct * stepRatio;
    count = numerator;
    stages.push({ key: g, label: STAGE_LABELS[g], count, pct: Math.round(exactPct * 10) / 10 });
  }

  const body: SummaryFunnelResponse = { hasAccess: true, stages, periodFrom, periodTo, dataAvailable: true };
  return NextResponse.json(body);
}
