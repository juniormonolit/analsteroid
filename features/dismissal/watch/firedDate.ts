// Дата увольнения на сотруднике (Увольнятор v4): прогон стал done → закрыть открытый период «кто на логине»
// в «Сотрудниках» (sa.employee_tenures.end_date — то же поле, что «Дата увольнения» в карточке, через ту же
// updateTenure из lib/org/tenures.ts). Дата — объявление в чате «Увольнения» (МСК), если кейс есть, иначе дата
// запуска прогона. Уже стоящую дату не трогаем: открытого периода нет — ничего не делаем.
import { systemDb } from '@/lib/db/clients';
import { listTenures, updateTenure, validateTenure } from '@/lib/org/tenures';

const mskDate = (d: Date) => d.toLocaleDateString('sv-SE', { timeZone: 'Europe/Moscow' });

export async function markFiredDate(runId: string, sourceId: number): Promise<string> {
  const run = await systemDb().query<{ started_at: Date | null; created_at: Date }>(
    'SELECT started_at, created_at FROM dismissal_runs WHERE id = $1', [runId],
  );
  if (!run.rows[0]) return 'прогон не найден';
  const announced = await systemDb().query<{ announced_at: Date }>(
    `SELECT announced_at FROM dismissal_watch_cases WHERE source_bitrix_id = $1 AND (run_id = $2 OR resolved_run_id = $2)
      ORDER BY announced_at DESC LIMIT 1`, [sourceId, runId],
  ).catch(() => ({ rows: [] as { announced_at: Date }[] })); // до наката 291 — без кейсов
  const date = mskDate(announced.rows[0]?.announced_at ?? run.rows[0].started_at ?? run.rows[0].created_at);
  const tenures = await listTenures(sourceId);
  const open = tenures.find(t => t.endDate === null);
  if (!open) return 'открытого периода нет (дата увольнения уже стоит или логин не в «Сотрудниках»)';
  const input = { personName: open.personName, startDate: open.startDate, endDate: date, position: open.position };
  const bad = validateTenure(input, tenures.filter(t => t.id !== open.id));
  if (bad) return `не поставлена: ${bad}`;
  await updateTenure(open.id, input, 'Увольнятор');
  return `дата увольнения ${date} — «${open.personName}»`;
}
