// Задачник: отдать картинку шаблона рекомендаций. БЕЗ сессии — по неугадываемому uuid: ссылку открывают из
// описания задачи Битрикса, где сессии Монолитики может не быть. Внутри — скриншоты отчётов (без ПДн).
// /api/* гейт proxy.ts не трогает, авторизацию роуты делают сами — здесь её сознательно нет.
import { NextRequest, NextResponse } from 'next/server';
import { loadTemplateImage } from '@/features/tasker/engine/templates';

export const dynamic = 'force-dynamic';

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const img = await loadTemplateImage((await params).id);
    if (!img) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    return new NextResponse(new Uint8Array(img.data), {
      headers: {
        'Content-Type': img.mime,
        'Content-Length': String(img.data.length),
        'Cache-Control': 'public, max-age=31536000, immutable',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch (e) {
    console.error('[tasker template image]', e);
    return NextResponse.json({ error: 'Ошибка' }, { status: 500 });
  }
}
