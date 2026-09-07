import { NextRequest, NextResponse } from 'next/server';
import { getClientIp } from '@/lib/auth/pin';
import { getMedia } from '@/features/tv/engine/store';
import { rateLimited, tooMany } from '@/features/tv/engine/rateLimit';

// Публичная отдача картинки телевизору. id — uuid (128 бит), перебор невозможен;
// содержимое неизменяемо → immutable-кэш.
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ip = getClientIp(req);
  if (rateLimited(`tv:media:${ip ?? 'na'}`, 60, 60)) return tooMany();
  const { id } = await params;
  const media = await getMedia(id);
  if (!media) return new NextResponse('Not found', { status: 404 });
  return new NextResponse(new Uint8Array(media.data), {
    headers: {
      'Content-Type': media.mime,
      'Content-Length': String(media.data.length),
      'Cache-Control': 'public, max-age=31536000, immutable',
      'X-Robots-Tag': 'noindex, nofollow, noarchive',
    },
  });
}
