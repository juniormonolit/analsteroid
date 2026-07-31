import { analyticsDb, systemDb } from '@/lib/db/clients';
import type { SessionUser } from '@/lib/auth/session';
import { getOffloadDeals, type OffloadFilters, type OffloadDealRow } from './offload';

// Закрытие сделок в Битриксе (задача 2635, ЭТАП 2). Стадия закрытия — C1:9
// «НЕ ТРОГАТЬ - ЗАПРЕЩЕНО (штраф 10 000 руб)» (stage_type=LOSS, сверено с
// sa.stages 31.07; ID прислал владелец). Вебхук — BITRIX_WEBHOOK_URL из env
// прода (rest/2098, scope включает 'crm' — проверено read-методами scope и
// crm.deal.fields; право ЗАПИСИ без мутации не проверяемо, ошибки прав
// обрабатываются per-сделка и показываются в UI).
//
// ТРЕБОВАНИЕ ВЛАДЕЛЬЦА ПО НАГРУЗКЕ («паковать в батчи и не отправлять слишком
// часто»): один запрос этого движка = ОДИН вызов batch.json Битрикса (до
// MAX_DEALS_PER_REQUEST=25 команд crm.deal.update). Паузу 1.5с между пачками
// и последовательность (не параллель) держит клиент (OffloadPage шлёт чанки
// по очереди) — так прогресс «закрыто X из Y» виден без SSE. Серверный лимит
// не даёт обойти батчинг толстым запросом.

export const CLOSE_STAGE_ID = 'C1:9';
export const CLOSE_STAGE_NAME = 'НЕ ТРОГАТЬ - ЗАПРЕЩЕНО (штраф 10 000 руб)';
export const MAX_DEALS_PER_REQUEST = 25;

export interface CloseResultItem {
  dealId: number;
  status: 'closed' | 'skipped' | 'error';
  detail?: string;
}

interface FreshRow { deal_id: string; open: boolean; stage_name: string | null }

// Свежая перепроверка стадии ПЕРЕД записью (улучшение №5 ТЗ): сделка могла
// продаться/измениться после загрузки списка — такие пропускаем, не трогаем.
async function fetchFreshOpen(dealIds: number[]): Promise<Map<number, { open: boolean; stageName: string }>> {
  const res = await analyticsDb().query<FreshRow>(
    `SELECT d.deal_id,
            (s.stage_type = 'NEW' OR (s.stage_type = 'WORK' AND s.event_type NOT IN ('sold','shipped'))) AS open,
            s.name AS stage_name
       FROM deals d JOIN stages s ON s.id = d.stage_id
      WHERE d.deal_id = ANY($1::bigint[])`,
    [dealIds],
  );
  return new Map(res.rows.map(r => [Number(r.deal_id), { open: r.open, stageName: r.stage_name ?? '?' }]));
}

interface BatchResponse {
  result?: {
    result?: Record<string, unknown>;
    result_error?: Record<string, { error?: string; error_description?: string } | string>;
  };
  error?: string;
  error_description?: string;
}

// экспорт для юнит-теста парсинга (dry-run без сети)
export async function bitrixBatchClose(dealIds: number[]): Promise<Map<number, { ok: boolean; err?: string }>> {
  const base = (process.env.BITRIX_WEBHOOK_URL ?? '').replace(/\/$/, '');
  if (!base) throw new Error('BITRIX_WEBHOOK_URL не задан в окружении');
  const cmd: Record<string, string> = {};
  for (const id of dealIds) {
    cmd[`d${id}`] = `crm.deal.update?id=${id}&fields[STAGE_ID]=${encodeURIComponent(CLOSE_STAGE_ID)}`;
  }
  const res = await fetch(`${base}/batch.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ halt: 0, cmd }),
  });
  const json = (await res.json()) as BatchResponse;
  if (json.error) throw new Error(`${json.error}: ${json.error_description ?? ''}`);
  const out = new Map<number, { ok: boolean; err?: string }>();
  const okMap = json.result?.result ?? {};
  const errMap = json.result?.result_error ?? {};
  for (const id of dealIds) {
    const key = `d${id}`;
    if (key in errMap) {
      const e = errMap[key];
      out.set(id, { ok: false, err: typeof e === 'string' ? e : `${e.error ?? ''} ${e.error_description ?? ''}`.trim() });
    } else if (key in okMap) {
      out.set(id, { ok: true });
    } else {
      out.set(id, { ok: false, err: 'нет ответа в batch-результате' });
    }
  }
  return out;
}

async function writeLog(session: SessionUser, items: { row: OffloadDealRow | undefined; dealId: number; status: string; detail: string | null }[], deptByManager: Map<string, string>): Promise<void> {
  if (items.length === 0) return;
  const cols = ['closed_by_user_id', 'closed_by_login', 'deal_id', 'deal_name', 'amount', 'kc_group', 'head_group', 'manager_id', 'manager_name', 'department_name', 'work_days', 'priced_stagnant_days', 'probability', 'was_recommended', 'status', 'detail'];
  const values: unknown[] = [];
  const tuples: string[] = [];
  for (const it of items) {
    const r = it.row;
    const tuple = [
      session.id, session.login, it.dealId, r?.dealName ?? null, r?.amount ?? null,
      r?.kcGroup ?? null, r?.headGroup ?? null, r?.managerId ?? null, r?.managerName ?? null,
      r ? (deptByManager.get(r.managerId) ?? null) : null,
      r?.workDays ?? null, r?.pricedStagnantDays ?? null, r?.probability ?? null,
      r?.recommended ?? null, it.status, it.detail,
    ];
    const ph = tuple.map(v => { values.push(v); return `$${values.length}`; });
    tuples.push(`(${ph.join(',')})`);
  }
  await systemDb().query(
    `INSERT INTO offload_close_log (${cols.join(',')}) VALUES ${tuples.join(',')}`,
    values,
  );
}

export async function closeDeals(
  session: SessionUser, dealIds: number[], filters: OffloadFilters,
): Promise<CloseResultItem[]> {
  const unique = [...new Set(dealIds)].slice(0, MAX_DEALS_PER_REQUEST);
  const [{ rows, org }, fresh] = await Promise.all([getOffloadDeals(filters), fetchFreshOpen(unique)]);
  const rowById = new Map(rows.map(r => [r.dealId, r]));
  const deptByManager = new Map<string, string>();
  for (const [id, o] of org) deptByManager.set(id, o.departmentName ?? 'Вне оргструктуры');

  const results: CloseResultItem[] = [];
  const toClose: number[] = [];
  for (const id of unique) {
    const f = fresh.get(id);
    if (!f) {
      results.push({ dealId: id, status: 'skipped', detail: 'сделка не найдена в sa' });
    } else if (!f.open) {
      results.push({ dealId: id, status: 'skipped', detail: `стадия изменилась: «${f.stageName}»` });
    } else {
      toClose.push(id);
    }
  }

  if (toClose.length > 0) {
    let batch: Map<number, { ok: boolean; err?: string }>;
    try {
      batch = await bitrixBatchClose(toClose);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      for (const id of toClose) results.push({ dealId: id, status: 'error', detail: msg });
      batch = new Map();
    }
    for (const [id, r] of batch) {
      results.push(r.ok
        ? { dealId: id, status: 'closed' }
        : { dealId: id, status: 'error', detail: r.err });
    }
  }

  await writeLog(
    session,
    results.map(r => ({ row: rowById.get(r.dealId), dealId: r.dealId, status: r.status, detail: r.detail ?? null })),
    deptByManager,
  );

  return results.sort((a, b) => a.dealId - b.dealId);
}
