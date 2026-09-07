import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { permError } from '@/lib/auth/perms';
import { MEDIA_MAX_BYTES, purgeOrphanMedia, saveMedia } from '@/features/tv/engine/store';

// Загрузка фона для полноэкранного сообщения (правка владельца 07.09). Тело —
// JSON { mime, data: base64 }: админка сама ужимает картинку canvas-ом до ≤1920px.
export async function POST(req: NextRequest) {
  const session = await getSession();
  const denied = permError(session, 'section.tv');
  if (denied) return denied;
  const body = await req.json().catch(() => null) as { mime?: string; data?: string } | null;
  if (!body?.mime || !body?.data) return NextResponse.json({ error: 'Нет файла' }, { status: 400 });
  const buf = Buffer.from(body.data, 'base64');
  if (buf.length > MEDIA_MAX_BYTES) return NextResponse.json({ error: 'Картинка больше 3 МБ' }, { status: 413 });
  const id = await saveMedia(body.mime, buf, session!.id);
  if (!id) return NextResponse.json({ error: 'Поддерживаются JPEG, PNG и WebP до 3 МБ' }, { status: 400 });
  void purgeOrphanMedia().catch(() => 0);
  return NextResponse.json({ id, url: `/api/tv/media/${id}` }, { status: 201 });
}
