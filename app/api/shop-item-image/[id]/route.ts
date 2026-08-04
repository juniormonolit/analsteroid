import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { systemDb } from '@/lib/db/clients';

// Отдать байты своей картинки товара (задача 2994) — тем же приёмом, что
// idea_attachments (app/api/ideas/[id]/attachments/[attId]/route.ts): байты
// прямо в БД, своего объектного хранилища нет. Инструмент внутренний — только
// залогиненным (и покупателям на витрине, и админам формы — оба уже сессия).
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { id } = await params;
  if (!/^\d+$/.test(id)) return NextResponse.json({ error: 'Bad id' }, { status: 400 });

  const res = await systemDb().query<{ image_data: Buffer | null; image_mime: string | null }>(
    `SELECT image_data, image_mime FROM shop_items WHERE id = $1`,
    [id],
  );
  const row = res.rows[0];
  if (!row || !row.image_data || !row.image_mime) {
    return NextResponse.json({ error: 'Не найдено' }, { status: 404 });
  }

  return new NextResponse(new Uint8Array(row.image_data), {
    status: 200,
    headers: {
      'Content-Type': row.image_mime,
      'Content-Length': String(row.image_data.length),
      // Короткий приватный кэш — картинка внутреннего инструмента, редко
      // меняется, но не бьёт по домену на каждый показ карточки.
      'Cache-Control': 'private, max-age=300',
    },
  });
}
