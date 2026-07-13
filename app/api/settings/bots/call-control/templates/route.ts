import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { permError } from '@/lib/auth/perms';
import { systemDb } from '@/lib/db/clients';
import { validateTemplate, type TemplateBody } from '@/lib/bots/callControlAdmin';

// Кастомные шаблоны сообщений бота «Контроль звонков» (call_control_templates).
// Плейсхолдеры движка: {manager_name} {phone} {deal_url} {missed_count} {minutes}
// {case_id} {recipient_name}.

export async function GET() {
  const session = await getSession();
  const denied = permError(session, 'section.settings');
  if (denied) return denied;

  const db = systemDb();
  const res = await db.query(
    `SELECT id, name, body, updated_at FROM call_control_templates ORDER BY id`
  );
  return NextResponse.json({ templates: res.rows });
}

export async function POST(req: NextRequest) {
  const session = await getSession();
  const denied = permError(session, 'section.settings');
  if (denied) return denied;

  const body = await req.json().catch(() => null) as TemplateBody | null;
  if (!body) return NextResponse.json({ error: 'bad body' }, { status: 400 });
  const invalid = validateTemplate(body, true);
  if (invalid) return NextResponse.json({ error: invalid }, { status: 400 });

  const db = systemDb();
  const res = await db.query(
    `INSERT INTO call_control_templates (name, body) VALUES ($1, $2) RETURNING id`,
    [body.name!.trim(), body.body!]
  );
  return NextResponse.json({ ok: true, id: res.rows[0].id });
}
