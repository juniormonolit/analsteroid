import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { superadminError } from '@/lib/auth/perms';
import { systemDb } from '@/lib/db/clients';

// Правка награды: вкл/выкл, имя/описание/иконка, пороги в criteria (jsonb).
// Конструктора НОВЫХ наград на этапе 1 нет — только правка существующих.
export async function PATCH(req: Request, { params }: { params: Promise<{ key: string }> }) {
  const session = await getSession();
  const err = superadminError(session);
  if (err) return err;

  const { key } = await params;
  let body: { enabled?: unknown; name?: unknown; description?: unknown; icon?: unknown; criteria?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Некорректный JSON' }, { status: 400 });
  }

  const sets: string[] = [];
  const vals: unknown[] = [];
  const push = (sql: string, v: unknown) => { vals.push(v); sets.push(`${sql} = $${vals.length}`); };

  if (typeof body.enabled === 'boolean') push('enabled', body.enabled);
  if (typeof body.name === 'string' && body.name.trim()) push('name', body.name.trim().slice(0, 200));
  if (typeof body.description === 'string') push('description', body.description.slice(0, 1000));
  if (typeof body.icon === 'string' && body.icon.trim()) push('icon', body.icon.trim().slice(0, 16));
  if (body.criteria !== undefined) {
    if (typeof body.criteria !== 'object' || body.criteria === null || Array.isArray(body.criteria)) {
      return NextResponse.json({ error: 'criteria: объект' }, { status: 400 });
    }
    // числовые пороги — только конечные неотрицательные числа
    for (const [k, v] of Object.entries(body.criteria as Record<string, unknown>)) {
      if (typeof v === 'number' && (!Number.isFinite(v) || v < 0)) {
        return NextResponse.json({ error: `criteria.${k}: некорректное число` }, { status: 400 });
      }
    }
    push('criteria', JSON.stringify(body.criteria));
  }
  if (sets.length === 0) return NextResponse.json({ error: 'Нет полей для сохранения' }, { status: 400 });

  vals.push(key);
  const res = await systemDb().query(
    `UPDATE badge_definitions SET ${sets.join(', ')}, updated_at = now() WHERE key = $${vals.length} RETURNING key`,
    vals,
  );
  if (res.rowCount === 0) return NextResponse.json({ error: 'Награда не найдена' }, { status: 404 });
  return NextResponse.json({ ok: true });
}
