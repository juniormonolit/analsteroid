import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { systemDb } from '@/lib/db/clients';
import type { IdeaAttachment } from '@/lib/ideas/types';
import {
  IDEA_ATTACH_MAX_BYTES,
  IDEA_ATTACH_MAX_COUNT,
  IDEA_ATTACH_ALLOWED_MIME,
} from '@/lib/ideas/types';

type Row = {
  id: string;
  filename: string;
  mime_type: string;
  byte_size: number;
  uploaded_by: string;
  created_at: Date;
};

function toAttachment(r: Row): IdeaAttachment {
  return {
    id: r.id,
    filename: r.filename,
    mimeType: r.mime_type,
    byteSize: r.byte_size,
    uploadedBy: r.uploaded_by,
    createdAt: r.created_at.toISOString(),
  };
}

// Метаданные вложений идеи (без байтов). Байты — /attachments/[attId].
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { id } = await params;
  const res = await systemDb().query<Row>(
    `SELECT id, filename, mime_type, byte_size, uploaded_by, created_at
       FROM idea_attachments WHERE idea_id = $1 ORDER BY created_at`,
    [id]
  );
  return NextResponse.json({ attachments: res.rows.map(toAttachment) });
}

// Загрузить скриншоты к идее (несколько за раз). Любой залогиненный пользователь —
// инструмент внутренний. Валидация: только картинки, ≤8 МБ, суммарно ≤6 на идею.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { id } = await params;
  const db = systemDb();

  const ideaRes = await db.query<{ id: string }>(`SELECT id FROM ideas WHERE id = $1`, [id]);
  if (!ideaRes.rows.length) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: 'Ожидается multipart/form-data' }, { status: 400 });
  }

  const files = form.getAll('files').filter((f): f is File => f instanceof File && f.size > 0);
  if (!files.length) return NextResponse.json({ error: 'Файлы не переданы' }, { status: 400 });

  const countRes = await db.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM idea_attachments WHERE idea_id = $1`,
    [id]
  );
  const existing = Number(countRes.rows[0]?.n ?? 0);
  if (existing + files.length > IDEA_ATTACH_MAX_COUNT) {
    return NextResponse.json(
      { error: `Максимум ${IDEA_ATTACH_MAX_COUNT} скриншотов на идею (уже ${existing})` },
      { status: 400 }
    );
  }

  for (const f of files) {
    if (!IDEA_ATTACH_ALLOWED_MIME.includes(f.type)) {
      return NextResponse.json({ error: `Недопустимый тип файла: ${f.name}` }, { status: 400 });
    }
    if (f.size > IDEA_ATTACH_MAX_BYTES) {
      return NextResponse.json({ error: `Файл больше 8 МБ: ${f.name}` }, { status: 400 });
    }
  }

  const created: IdeaAttachment[] = [];
  for (const f of files) {
    const buf = Buffer.from(await f.arrayBuffer());
    const res = await db.query<Row>(
      `INSERT INTO idea_attachments (idea_id, filename, mime_type, byte_size, data, uploaded_by)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, filename, mime_type, byte_size, uploaded_by, created_at`,
      [id, f.name.slice(0, 200), f.type, buf.length, buf, session.login]
    );
    created.push(toAttachment(res.rows[0]));
  }

  return NextResponse.json({ ok: true, attachments: created });
}
