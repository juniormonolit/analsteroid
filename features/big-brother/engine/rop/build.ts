// «Большой брат» — рейтинг РОПов (запрос Осипова): как РОП ставит задачи подчинённым в Задачнике, канбане больших чеков
// и канбане повторки — против показателей отдела. Только админы (гейт — access.ts, проверяет роут).
//
// РОП = rop_bitrix_user_id из sa.org_resolved_hierarchy, у которого есть хотя бы один подчинённый-продавец
// (логин manager*). Подчинённые — действующие сотрудники с этим РОПом, кроме него самого.
import { loadLogins, loadOrg, loadRopTasks, type OrgPerson } from './sources';
import { aggregate, memberMetrics } from './deptMetrics';
import { daysOf, isWorkday, mskDay, periodBounds, weekStart, workWeeksOf, type BbPeriod } from './period';
import type { RopRatingResponse, RopRow, RopSubordinate, RopTask, ServiceCounts } from './types';

const OPEN = new Set([1, 2, 3, 6]);
const zeroSvc = (): ServiceCounts => ({ tasker: 0, big: 0, repeat: 0 });
const IMPROVED = new Set(['achieved', 'improved']);
const MEASURED = new Set(['achieved', 'improved', 'no_change']);

export async function buildRopRating(period: BbPeriod, now = Date.now()): Promise<RopRatingResponse> {
  const notes: string[] = [];
  const [org, logins] = await Promise.all([loadOrg(), loadLogins()]);
  const isSeller = (id: string) => !logins.size || (logins.get(id) ?? '').toLowerCase().startsWith('manager');

  const byId = new Map(org.map(p => [p.id, p]));
  const teams = new Map<string, OrgPerson[]>();
  for (const p of org) {
    if (!p.ropId || p.ropId === p.id || !isSeller(p.id)) continue;
    const list = teams.get(p.ropId) ?? [];
    list.push(p);
    teams.set(p.ropId, list);
  }
  const ropIds = [...teams.keys()];
  const { fromIso, toExclIso } = periodBounds(period);

  const shortLoginById = new Map<string, string>();
  for (const p of org) if (p.shortLogin) shortLoginById.set(p.id, p.shortLogin);

  const [act, metrics] = await Promise.all([
    loadRopTasks(ropIds, fromIso, toExclIso),
    memberMetrics(period, shortLoginById).catch(e => {
      console.warn('[big-brother rop] показатели отдела', e instanceof Error ? e.message : e);
      notes.push('Показатели отдела не посчитались (ошибка движка отчётов) — колонки пустые.');
      return null;
    }),
  ]);

  const weekStarts = workWeeksOf(period);
  const workdays = daysOf(period).filter(isWorkday).length;
  const tasksBy = new Map<string, RopTask[]>();
  for (const t of act.tasks) {
    const list = tasksBy.get(t.creatorId) ?? [];
    list.push(t);
    tasksBy.set(t.creatorId, list);
  }

  const rows: RopRow[] = ropIds.map(ropId => {
    const team = teams.get(ropId)!;
    const self = byId.get(ropId);
    const tasks = tasksBy.get(ropId) ?? [];
    const subIds = new Set(team.map(p => p.id));
    const byService = zeroSvc();
    let mono = 0, direct = 0;
    const days = new Set<string>();
    const weekly = new Map<string, number>(weekStarts.map(w => [w, 0]));
    const follow = {
      closed: 0, waitingControl: 0, accepted: act.repeatAccepted.get(ropId) ?? 0, overdueOpen: 0,
      returned: act.repeatReturned.get(ropId) ?? 0, taskerMeasured: 0, taskerImproved: 0,
    };
    const perSub = new Map<string, { tasks: number; byService: ServiceCounts; closed: number; overdueOpen: number; last: string | null }>();
    for (const t of tasks) {
      byService[t.service]++;
      if (t.via === 'mono') mono++; else direct++;
      const day = mskDay(t.createdAt);
      days.add(day);
      const w = weekStart(day);
      if (weekly.has(w)) weekly.set(w, weekly.get(w)! + 1);
      const closed = t.status === 5;
      const overdue = t.status != null && OPEN.has(t.status) && !!t.deadlineAt && Date.parse(t.deadlineAt) < now;
      if (closed) {
        follow.closed++;
        // Закрыл сам постановщик — значит, проверил и принял (в Битриксе с контролем закрывает постановщик).
        if (t.closedBy === ropId && t.service !== 'repeat') follow.accepted++;
      }
      if (t.status === 4) follow.waitingControl++;
      if (overdue) follow.overdueOpen++;
      if (t.service === 'tasker' && t.verdict && MEASURED.has(t.verdict)) {
        follow.taskerMeasured++;
        if (IMPROVED.has(t.verdict)) follow.taskerImproved++;
      }
      if (t.assigneeId && subIds.has(t.assigneeId)) {
        const s = perSub.get(t.assigneeId) ?? { tasks: 0, byService: zeroSvc(), closed: 0, overdueOpen: 0, last: null };
        s.tasks++; s.byService[t.service]++;
        if (closed) s.closed++;
        if (overdue) s.overdueOpen++;
        if (!s.last || t.createdAt > s.last) s.last = t.createdAt;
        perSub.set(t.assigneeId, s);
      }
    }
    const subs: RopSubordinate[] = team.map(p => {
      const s = perSub.get(p.id);
      return {
        id: p.id, name: p.name, deptName: p.deptName, tasks: s?.tasks ?? 0, byService: s?.byService ?? zeroSvc(),
        closed: s?.closed ?? 0, overdueOpen: s?.overdueOpen ?? 0, lastTaskAt: s?.last ?? null,
        metrics: metrics ? aggregate([p.id], metrics) : null,
      };
    }).sort((a, b) => b.tasks - a.tasks || a.name.localeCompare(b.name, 'ru'));
    const weeklyArr = weekStarts.map(w => weekly.get(w) ?? 0);
    return {
      id: ropId,
      name: self?.name ?? team[0]?.ropName ?? `#${ropId}`,
      deptNames: [...new Set(team.map(p => p.deptName).filter((v): v is string => !!v))],
      branch: self?.branch ?? team[0]?.branch ?? null,
      subordinates: team.length,
      tasks: tasks.length,
      tasksPerSub: team.length ? tasks.length / team.length : null,
      byService, mono, direct,
      activeDays: days.size, workdays,
      gapWeeks: weeklyArr.filter(n => n === 0).length, weeks: weekStarts.length, weekly: weeklyArr,
      covered: perSub.size,
      coverage: team.length ? perSub.size / team.length : null,
      follow,
      taskerImprovedPct: follow.taskerMeasured ? follow.taskerImproved / follow.taskerMeasured : null,
      dept: metrics ? aggregate([...subIds, ropId], metrics) : null,
      subs,
    };
  }).sort((a, b) => b.tasks - a.tasks || a.name.localeCompare(b.name, 'ru'));

  notes.push(
    'Команда РОПа — по оргструктуре на сегодня: истории оргструктуры нет, переводы между отделами в периоде не учитываются.',
    'Реакция (время от появления большого чека / клиента в очереди повторки до первой задачи) — фаза 1: момент появления клиента в очереди повторки нигде не хранится, а у больших чеков дата назначения менеджера есть только в истории задачи Битрикса (REST), не в копии.',
    'Большие чеки: считаются задачи, созданные РОПом в проектах больших сделок. «Назначил менеджера» на чужой задаче — фаза 1 (история исполнителя есть только в REST Битрикса).',
    'Возвраты на доработку — только из канбана повторки: в копии Битрикса нет истории статусов.',
    'Активность самого РОПа в Монолитике — после журнала activity_* (поток A, вкладка «Люди»).',
  );
  return { period, weekStarts, generatedAt: new Date(now).toISOString(), rows, notes };
}
