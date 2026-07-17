import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { listWidgetTokens, createWidgetToken, revokeWidgetToken } from '@/lib/widget/tokens';

export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const tokens = await listWidgetTokens(session.id);
  return NextResponse.json({ tokens });
}

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const body = await req.json().catch(() => ({}));
  const label = typeof body?.label === 'string' ? body.label.slice(0, 64) : null;
  const token = await createWidgetToken(session.id, label);
  return NextResponse.json({ token });
}

export async function DELETE(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const token = req.nextUrl.searchParams.get('token') ?? '';
  const ok = await revokeWidgetToken(session.id, token);
  if (!ok) return NextResponse.json({ error: 'Токен не найден' }, { status: 404 });
  return NextResponse.json({ ok: true });
}
