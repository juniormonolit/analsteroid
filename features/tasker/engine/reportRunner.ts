// Прогон отчёта «По менеджерам» ТЕМ ЖЕ кодом, что видит человек (POST /api/reports/run) —
// как features/reports/engine/metricSeriesViaReport.ts: цифры снимка = ячейки отчёта.
//
// Два способа:
//  - inRequestRunner — внутри API-запроса: роут вызывается в процессе, getSession() читает
//    cookie текущего запроса, срез данных — того, кто смотрит;
//  - loopbackRunner(userId) — фоновая задача (автозамер), где cookie нет: создаём короткую
//    сессию постановщика задачи, зовём свой же сервер по HTTP и сразу удаляем сессию.
//    Так замер считается «глазами» постановщика, как авторассылка отчётов (reportSchedules).
import { NextRequest } from 'next/server';
import { createSession, deleteSession, SESSION_COOKIE } from '@/lib/auth/session';
import type { ReportRow } from '@/lib/metrics/types';

export type RunRow = ReportRow & { deltas?: Record<string, { current: number | null }>; isGroup?: boolean };
export interface RunResponse {
  rows: RunRow[];
  grouped?: RunRow[];
  totals?: Record<string, { current: number | null }>;
}
export type ReportRunner = (body: Record<string, unknown>) => Promise<RunResponse>;

export const inRequestRunner: ReportRunner = async body => {
  const { POST } = await import('@/app/api/reports/run/route');
  const req = new NextRequest('http://internal/api/reports/run', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const res = await POST(req);
  if (!res.ok) {
    const err = await res.json().catch(() => null) as { error?: string } | null;
    throw new Error(err?.error ?? `run ${res.status}`);
  }
  return res.json() as Promise<RunResponse>;
};

function internalBaseUrl(): string {
  return (process.env.TASKER_INTERNAL_URL || `http://127.0.0.1:${process.env.PORT || 3000}`).replace(/\/+$/, '');
}

/** Выполнить fn с раннером «от имени» пользователя (users.id); сессия живёт только на время fn. */
export async function withLoopbackRunner<T>(userId: string, fn: (run: ReportRunner) => Promise<T>): Promise<T> {
  const token = await createSession(userId);
  try {
    const run: ReportRunner = async body => {
      const res = await fetch(`${internalBaseUrl()}/api/reports/run`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: `${SESSION_COOKIE}=${token}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(120_000),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => null) as { error?: string } | null;
        throw new Error(err?.error ?? `run ${res.status}`);
      }
      return res.json() as Promise<RunResponse>;
    };
    return await fn(run);
  } finally {
    await deleteSession(token).catch(() => {});
  }
}

export function cellOf(row: RunRow | undefined, id: string): number | null {
  if (!row) return null;
  const v = row.deltas?.[id]?.current ?? row.metrics?.[id] ?? null;
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}
