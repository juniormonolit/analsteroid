import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { superadminError } from '@/lib/auth/perms';
import { systemDb } from '@/lib/db/clients';

// Правка причины штрафа: имя/размер/режим/вкл-выкл. Прошлые штрафы НЕ
// пересчитываются — сумма зафиксирована в леджере на момент операции.
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  const err = superadminError(session);
  if (err) return err;

  const { id } = await params;
  if (!/^\d+$/.test(id)) return NextResponse.json({ error: 'Некорректный id' }, { status: 400 });
  let body: { name?: unknown; price?: unknown; priceMode?: unknown; enabled?: unknown };
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Некорректный JSON' }, { status: 400 }); }

  const sets: string[] = [];
  const vals: unknown[] = [];
  const push = (sql: string, v: unknown) => { vals.push(v); sets.push(`${sql} = $${vals.length}`); };

  if (typeof body.name === 'string' && body.name.trim()) push('name', body.name.trim().slice(0, 300));
  if (body.priceMode === 'fixed' || body.priceMode === 'percent') push('price_mode', body.priceMode);
  if (body.price !== undefined) {
    if (typeof body.price !== 'number' || !Number.isInteger(body.price) || body.price <= 0 || body.price > 1_000_000) {
      return NextResponse.json({ error: 'Размер — целое число больше нуля' }, { status: 400 });
    }
    push('price', body.price);
  }
  if (typeof body.enabled === 'boolean') push('enabled', body.enabled);
  if (sets.length === 0) return NextResponse.json({ error: 'Нет полей для сохранения' }, { status: 400 });

  const vlen = vals.push(Number(id));
  const r = await systemDb().query(
    `UPDATE penalty_types SET ${sets.join(', ')}, updated_at = now() WHERE id = $${vlen} RETURNING id`,
    vals,
  );
  if (r.rowCount === 0) return NextResponse.json({ error: 'Причина не найдена' }, { status: 404 });
  return NextResponse.json({ ok: true });
}
