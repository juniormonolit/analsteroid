import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { fetchClientTail } from '@/features/reports/engine/clientTail';
import { resolveClientTailRequest } from '@/features/reports/engine/clientTailRequest';

// «Вход и хвост» (задача владельца 19.10). Разбор фильтров и права — в
// resolveClientTailRequest (общий с дриллом), математика — в движке.
export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const parsed = await resolveClientTailRequest(session, await req.json());
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: parsed.status });

  const start = Date.now();
  const result = await fetchClientTail(parsed.opts);
  console.log(`[client-tail] вход ${result.entry.shipments} отгр. / ${result.entry.created} сделок, хвост ${result.tail.shipments} отгр. за ${Date.now() - start} мс`);
  return NextResponse.json(result);
}
