// «Большой брат» → «Месяц по РОПам» (собрание 26.11, ТЗ tz/2026-11-26_big-brother.md, п. 2): действия РОПа против
// результата команды за период и его изменение к прошлому такому же периоду. Не второй источник: задачи, охват, «проверено»
// и показатели отдела — из buildRopRating (тот же расчёт, что подробная сводка); прошлый период — тем же memberMetrics.
// Добавлены только разборы (tasker_sessions + «Практики» один на один) и «на обучение» (задачи «Теория») — из Задачника.
import { systemDb } from '@/lib/db/clients';
import { buildRopRating } from './build';
import { aggregate, memberMetrics } from './deptMetrics';
import { addDays, daysOf, periodBounds, type BbPeriod } from './period';
import { loadTeams } from './sources';
import type { RopMonthResponse, RopMonthRow } from './types';

/**
 * Прошлый период для сравнения. Период с 1-го числа (календарный месяц или его начало) — те же числа прошлого месяца
 * (1–27 ноября → 1–27 октября; конец месяца прижат к последнему дню). Иначе — столько же дней прямо перед периодом.
 */
export function prevPeriodOf(p: BbPeriod): BbPeriod {
  if (p.from.endsWith('-01')) {
    const [y, m] = p.from.split('-').map(Number);
    const py = m === 1 ? y - 1 : y, pm = m === 1 ? 12 : m - 1;
    const lastDay = new Date(Date.UTC(py, pm, 0)).getUTCDate();
    const toDay = Math.min(Number(p.to.slice(8, 10)), lastDay);
    const sameMonth = p.to.slice(0, 7) === p.from.slice(0, 7);
    const mm = String(pm).padStart(2, '0');
    if (sameMonth) return { from: `${py}-${mm}-01`, to: `${py}-${mm}-${String(toDay).padStart(2, '0')}` };
  }
  const n = daysOf(p).length;
  return { from: addDays(p.from, -n), to: addDays(p.from, -1) };
}

export async function buildRopMonth(period: BbPeriod, now = Date.now()): Promise<RopMonthResponse> {
  const prevPeriod = prevPeriodOf(period);
  const { fromIso, toExclIso } = periodBounds(period);
  const nowIso = new Date(now).toISOString();
  const toIso = toExclIso < nowIso ? toExclIso : nowIso;
  const notes: string[] = [];
  const teamsP = loadTeams();

  const [rating, teams, prevMetrics, meetings, training] = await Promise.all([
    buildRopRating(period, now),
    teamsP,
    teamsP.then(t => memberMetrics(prevPeriod, t.shortLoginById)).catch(e => {
      console.warn('[big-brother rop/month] прошлый период', e instanceof Error ? e.message : e);
      notes.push('Показатели прошлого периода не посчитались — колонки изменений пустые.');
      return null;
    }),
    // Разборы до «сейчас»: сессии с хоть одной живой задачей + «Практики» один на один (без сессии, со слотом).
    systemDb().query<{ rop: string; n: number; held: number }>(
      `SELECT rop, count(*)::int AS n, count(*) FILTER (WHERE held)::int AS held FROM (
         SELECT s.rop_bitrix_id AS rop, s.held_at IS NOT NULL AS held FROM tasker_sessions s
          WHERE s.slot_start >= $1 AND s.slot_start < $2
            AND EXISTS (SELECT 1 FROM tasker_tasks t WHERE t.session_id = s.id AND t.cancelled_at IS NULL)
         UNION ALL
         SELECT creator_bitrix_id, false FROM tasker_tasks
          WHERE cancelled_at IS NULL AND session_id IS NULL AND kind = 'practice' AND slot_start >= $1 AND slot_start < $2
       ) x WHERE rop IS NOT NULL GROUP BY rop`, [fromIso, toIso],
    ).then(r => new Map(r.rows.map(x => [x.rop, x]))).catch(e => {
      console.warn('[big-brother rop/month] разборы', e instanceof Error ? e.message : e);
      notes.push('Разборы Задачника не прочитались — колонка пустая.');
      return null;
    }),
    systemDb().query<{ who: string; n: number }>(
      `SELECT creator_bitrix_id AS who, count(*)::int AS n FROM tasker_tasks
        WHERE cancelled_at IS NULL AND kind = 'theory' AND created_at >= $1 AND created_at < $2 GROUP BY 1`,
      [fromIso, toExclIso],
    ).then(r => new Map(r.rows.map(x => [x.who, x.n]))).catch(() => null),
  ]);

  const rows: RopMonthRow[] = rating.rows.map(r => {
    const team = teams.teams.get(r.id) ?? [];
    const m = meetings?.get(r.id);
    return {
      id: r.id, name: r.name, deptNames: r.deptNames, subordinates: r.subordinates,
      tasks: r.tasks, tasksPerSub: r.tasksPerSub, coverage: r.coverage,
      meetings: m?.n ?? 0, meetingsHeld: m?.held ?? 0, training: training?.get(r.id) ?? 0,
      accepted: r.follow.accepted, returned: r.follow.returned,
      dept: r.dept,
      prev: prevMetrics ? aggregate([...team.map(p => p.id), r.id], prevMetrics) : null,
    };
  });

  notes.push(
    `Сравнение — с ${fmt(prevPeriod.from)}–${fmt(prevPeriod.to)}. Δ продаж — в процентах, Δ плана и конверсий — в процентных пунктах.`,
    'Команда — по оргструктуре на сегодня и для прошлого периода тоже (истории оргструктуры нет).',
    '«Разборов» — сессии Задачника и «Практики» один на один, чей слот уже наступил; «отмечено» — РОП нажал «Провёл».',
    'Связь действий и результата — подсказка, не доказательство: на истории 12 РОПов связи числа задач с продажами через 2–3 недели не видно (вкладка «Задачи × продажи»).',
    ...rating.notes.filter(n => n.startsWith('Показатели отдела')),
  );
  return { period, prevPeriod, generatedAt: new Date(now).toISOString(), rows, notes };
}

const fmt = (d: string) => `${d.slice(8, 10)}.${d.slice(5, 7)}`;
