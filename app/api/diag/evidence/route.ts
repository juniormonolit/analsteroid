import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { superadminError } from '@/lib/auth/perms';
import { systemDb } from '@/lib/db/clients';
import { loadEvidence } from '@/features/diag/engine/evidence';

// Доказательства диагноза: конкретные сделки/клиенты за цифрой. Сначала пробуем рычаг
// (он про действие), при пустом результате — сам просевший узел.
export const maxDuration = 120;

export async function GET(req: NextRequest) {
  const session = await getSession();
  const err = superadminError(session);
  if (err) return err;
  const id = Number(req.nextUrl.searchParams.get('diagnosisId'));
  if (!Number.isInteger(id)) return NextResponse.json({ error: 'Нужен diagnosisId' }, { status: 400 });
  const r = await systemDb().query<{ subject_key: string; node_id: string; lever_id: string | null }>(
    `SELECT subject_key, node_id, lever_id FROM diag_diagnoses WHERE id = $1`, [id]);
  const d = r.rows[0];
  if (!d) return NextResponse.json({ error: 'Диагноз не найден' }, { status: 404 });
  const mgr = Number(d.subject_key);
  try {
    let ev = await loadEvidence(d.lever_id ?? d.node_id, mgr);
    if (ev.kind === 'none' || ev.rows.length === 0) {
      const alt = await loadEvidence(d.node_id, mgr);
      if (alt.rows.length > 0) ev = alt;
    }
    return NextResponse.json({ evidence: ev });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
