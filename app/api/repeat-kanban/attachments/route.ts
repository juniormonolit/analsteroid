import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { hasPerm } from '@/lib/auth/perms';
import { ATTACH_MAX_BYTES, ATTACH_MAX_COUNT, uploadAttachment } from '@/features/repeat-kanban/engine/attachments';

// Файлы к комментарию задачи (attachments.ts): multipart `files` → Диск Битрикса → одноразовые токены,
// которые клиент тут же передаёт в действие POST /api/repeat-kanban ({ attachments: [...] }).
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!hasPerm(session, 'section.repeat_kanban')) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  const form = await req.formData().catch(() => null);
  const files = (form?.getAll('files') ?? []).filter((f): f is File => typeof f === 'object' && f !== null && 'arrayBuffer' in f);
  if (!files.length) return NextResponse.json({ error: 'Нет файлов' }, { status: 400 });
  if (files.length > ATTACH_MAX_COUNT) return NextResponse.json({ error: `Не больше ${ATTACH_MAX_COUNT} файлов` }, { status: 400 });
  const big = files.find(f => f.size > ATTACH_MAX_BYTES);
  if (big) return NextResponse.json({ error: `Файл больше ${ATTACH_MAX_BYTES / 1024 / 1024} МБ: ${big.name}` }, { status: 400 });
  try {
    const out = [];
    for (const f of files) out.push(await uploadAttachment(session.login, f.name, Buffer.from(await f.arrayBuffer())));
    return NextResponse.json({ files: out });
  } catch (e) {
    console.error('[repeat-kanban attachments]', e instanceof Error ? e.message : e);
    return NextResponse.json({ error: 'Не удалось загрузить файлы в Битрикс' }, { status: 502 });
  }
}
