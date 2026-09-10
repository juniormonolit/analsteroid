import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { superadminError } from '@/lib/auth/perms';
import { systemDb } from '@/lib/db/clients';
import { getEmployeeDirectory } from '@/lib/org/employeeDirectory';

// Диагнозы (ТЗ №1 §11): GET — открытые/в очереди/спорные + закрытые за 14 дней с именами
// узлов и менеджеров; POST — «Не согласен» (diag_feedback) → статус disputed.
export async function GET(req: NextRequest) {
  const session = await getSession();
  const err = superadminError(session);
  if (err) return err;
  const all = req.nextUrl.searchParams.get('all') === '1';
  // Имена — из sa.org_resolved_hierarchy (users.bitrix_user_id заполнен лишь у части).
  const [dir, r] = await Promise.all([getEmployeeDirectory().catch(() => new Map()), systemDb().query<{
    id: string; subject_key: string; manager_name: string | null; node_id: string; node_name: string; lever_id: string | null; lever_name: string | null;
    gap_value: string | null; gap_share: string | null; score: string | null; mode: string; arm: string; too_late_for_month: boolean; recipient_role: string | null;
    status: string; outcome: string | null; trace: unknown; opened_at: Date; closed_at: Date | null; feedback_n: string;
  }>(
    `SELECT d.id::text, d.subject_key, u.display_name AS manager_name, d.node_id, n.name AS node_name, d.lever_id, l.name AS lever_name,
            d.gap_value::text, d.gap_share::text, d.score::text, d.mode, d.arm, d.too_late_for_month, d.recipient_role, d.status, d.outcome, d.trace, d.opened_at, d.closed_at,
            (SELECT count(*) FROM diag_feedback f WHERE f.diagnosis_id = d.id)::text AS feedback_n
       FROM diag_diagnoses d
       JOIN diag_nodes n ON n.id = d.node_id
       LEFT JOIN diag_nodes l ON l.id = d.lever_id
       LEFT JOIN users u ON u.bitrix_user_id = d.subject_key
      WHERE d.subject_type = 'manager' AND (${all ? 'true' : "d.status IN ('open','queued','in_scenario','disputed') OR d.closed_at > now() - interval '14 days'"})
      ORDER BY (d.status IN ('open','disputed','in_scenario')) DESC, d.score DESC NULLS LAST, d.opened_at DESC LIMIT 500`)]);
  const n = (v: string | null) => (v === null ? null : Number(v));
  return NextResponse.json({
    diagnoses: r.rows.map(x => ({
      id: Number(x.id), bitrixId: Number(x.subject_key), managerName: dir.get(Number(x.subject_key))?.name ?? x.manager_name ?? `#${x.subject_key}`, nodeId: x.node_id, nodeName: x.node_name,
      leverId: x.lever_id, leverName: x.lever_name, gapValue: n(x.gap_value), gapShare: n(x.gap_share), score: n(x.score), mode: x.mode, arm: x.arm,
      tooLate: x.too_late_for_month, recipientRole: x.recipient_role, status: x.status, outcome: x.outcome, trace: x.trace,
      openedAt: new Date(x.opened_at).toISOString(), closedAt: x.closed_at ? new Date(x.closed_at).toISOString() : null, feedbackN: Number(x.feedback_n),
    })),
  });
}

export async function POST(req: NextRequest) {
  const session = await getSession();
  const err = superadminError(session);
  if (err) return err;
  const body = await req.json().catch(() => null) as { id?: number; reason?: string; comment?: string } | null;
  const id = Number(body?.id);
  const reason = String(body?.reason ?? '');
  if (!Number.isInteger(id) || !['wrong_lever', 'not_managers_fault', 'data_error', 'already_handled', 'other'].includes(reason)) {
    return NextResponse.json({ error: 'Нужны id и причина' }, { status: 400 });
  }
  const db = systemDb();
  await db.query(`INSERT INTO diag_feedback (diagnosis_id, author_login, reason, comment) VALUES ($1, $2, $3, $4)`, [id, session!.login, reason, String(body?.comment ?? '').slice(0, 2000) || null]);
  await db.query(`UPDATE diag_diagnoses SET status = 'disputed' WHERE id = $1 AND status IN ('open', 'queued')`, [id]);
  return NextResponse.json({ ok: true });
}
