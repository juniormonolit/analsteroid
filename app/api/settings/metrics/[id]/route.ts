import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { permError } from '@/lib/auth/perms';
import { ycAnalyticsDb } from '@/lib/db/clients';
import { invalidateMetricsCache } from '@/lib/metrics/catalog';

const ALLOWED_FIELDS = ['name_ru', 'name_short_ru', 'description', 'calc_ok', 'fill_ok'] as const;
type AllowedField = typeof ALLOWED_FIELDS[number];

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getSession();
  const denied = permError(session, 'section.settings');
  if (denied) return denied;

  const { id } = await params;
  const body = await req.json() as Record<string, unknown>;

  const updates: { field: AllowedField; value: unknown }[] = [];
  for (const field of ALLOWED_FIELDS) {
    if (field in body) {
      updates.push({ field, value: body[field] });
    }
  }

  if (updates.length === 0) {
    return NextResponse.json({ error: 'No valid fields to update' }, { status: 400 });
  }

  const setClauses = updates.map((u, i) => `${u.field} = $${i + 1}`).join(', ');
  const values = [...updates.map(u => u.value), id];

  const db = ycAnalyticsDb();
  const res = await db.query(
    `UPDATE metrics SET ${setClauses} WHERE id = $${updates.length + 1} RETURNING id`,
    values
  );

  if (!res.rows.length) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  invalidateMetricsCache();

  return NextResponse.json({ ok: true });
}
