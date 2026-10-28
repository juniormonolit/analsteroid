import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { fetchClientTailDrill, type DrillKind, type DrillSide } from '@/features/reports/engine/clientTail';
import { resolveClientTailRequest } from '@/features/reports/engine/clientTailRequest';

// Дрилл «Вход и хвост» (задача владельца 28.10: «проваливаться в сделки и в
// клиентов»). Тело = тело отчёта + target { side, kind, group, contactId } — те же
// фильтры и права, что у сводки, поэтому список совпадает с кликнутой цифрой.
export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await req.json();
  const parsed = await resolveClientTailRequest(session, body);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: parsed.status });

  const t = (body.target ?? {}) as Record<string, unknown>;
  const side = (['entry', 'tail', 'both'] as const).find(v => v === t.side);
  const kind = (['created', 'shipments', 'clients'] as const).find(v => v === t.kind);
  if (!side || !kind) return NextResponse.json({ error: 'target.side / target.kind некорректны' }, { status: 400 });
  const group = typeof t.group === 'string' && t.group.length <= 200 ? t.group : null;
  const contactId = typeof t.contactId === 'string' && /^\d+$/.test(t.contactId) ? t.contactId : null;
  if (side === 'both' && !contactId) return NextResponse.json({ error: 'side=both — только для одного клиента' }, { status: 400 });

  const result = await fetchClientTailDrill(parsed.opts, { side: side as DrillSide, kind: kind as DrillKind, group, contactId });
  return NextResponse.json(result);
}
