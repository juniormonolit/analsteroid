import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { superadminError } from '@/lib/auth/perms';
import { systemDb } from '@/lib/db/clients';

// Журнал сценария: открытые цепочки (кто на каком шаге, когда проверка) и
// последние отправленные сообщения — что бот реально сказал человеку.
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  const err = superadminError(session);
  if (err) return err;
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/.test(id)) return NextResponse.json({ error: 'Не указан сценарий' }, { status: 400 });
  const db = systemDb();
  const [runs, events] = await Promise.all([
    db.query<{
      id: string; manager_bitrix_id: string; name: string | null; status: string; step: number; start_value: string | null;
      last_value: string | null; branch: string; node_id: string | null; resume_at: string | null; created_at: string | Date; closed_at: string | Date | null; closed_reason: string | null;
    }>(
      `SELECT r.id::text, r.manager_bitrix_id::text, u.display_name AS name, r.status, r.step, r.start_value, r.last_value,
              r.branch, r.node_id, to_char(r.resume_at, 'YYYY-MM-DD') AS resume_at, r.created_at, r.closed_at, r.closed_reason
         FROM bot_scenario_runs r LEFT JOIN users u ON u.bitrix_user_id = r.manager_bitrix_id::text
        WHERE r.scenario_id = $1
        ORDER BY (r.status = 'open') DESC, r.created_at DESC LIMIT 200`,
      [id],
    ),
    db.query<{ id: string; manager_bitrix_id: string; name: string | null; kind: string; value: string | null; threshold: string | null; text: string; branch: string | null; node_id: string | null; created_at: string | Date }>(
      `SELECT e.id::text, e.manager_bitrix_id::text, u.display_name AS name, e.kind, e.value, e.threshold, e.text, e.branch, e.node_id, e.created_at
         FROM bot_scenario_events e LEFT JOIN users u ON u.bitrix_user_id = e.manager_bitrix_id::text
        WHERE e.scenario_id = $1 ORDER BY e.created_at DESC LIMIT 200`,
      [id],
    ),
  ]);
  const n = (v: string | null) => (v === null ? null : Number(v));
  const d = (v: string | Date | null) => (v ? new Date(v).toISOString() : null);
  return NextResponse.json({
    runs: runs.rows.map(r => ({
      id: r.id, bitrixId: Number(r.manager_bitrix_id), name: r.name ?? `#${r.manager_bitrix_id}`, status: r.status, step: r.step,
      startValue: n(r.start_value), lastValue: n(r.last_value), branch: r.branch, nodeId: r.node_id, resumeAt: r.resume_at,
      createdAt: d(r.created_at)!, closedAt: d(r.closed_at), closedReason: r.closed_reason,
    })),
    events: events.rows.map(e => ({
      id: e.id, bitrixId: Number(e.manager_bitrix_id), name: e.name ?? `#${e.manager_bitrix_id}`, kind: e.kind,
      value: n(e.value), threshold: n(e.threshold), text: e.text, branch: e.branch, nodeId: e.node_id, createdAt: d(e.created_at)!,
    })),
  });
}
