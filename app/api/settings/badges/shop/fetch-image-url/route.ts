import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { superadminError } from '@/lib/auth/perms';
import { safeFetchImageFromUrl, SHOP_IMAGE_MAX_BYTES } from '@/lib/images/shopItemImage';

// «Своя картинка по ссылке» — сервер САМ скачивает и возвращает байты клиенту
// (base64, НЕ сохраняет тут же — сохранение идёт вместе с формой товара,
// POST/PATCH .../shop, единым сейвом). Скачивание СЕРВЕРОМ по ссылке от
// пользователя — классический SSRF; вся защита — в lib/images/shopItemImage.ts
// (только http(s), приватные/служебные IP запрещены, редиректы валидируются
// по одному, таймаут, потоковый лимит байт, сигнатура по факту содержимого).
// Только суперадмин — та же форма, что редактирует каталог магазина.
export async function POST(req: Request) {
  const session = await getSession();
  const err = superadminError(session);
  if (err) return err;

  let body: { url?: unknown };
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Некорректный JSON' }, { status: 400 }); }
  const url = typeof body.url === 'string' ? body.url.trim() : '';
  if (!url) return NextResponse.json({ error: 'Ссылка не передана' }, { status: 400 });
  if (url.length > 2000) return NextResponse.json({ error: 'Слишком длинная ссылка' }, { status: 400 });

  const result = await safeFetchImageFromUrl(url);
  if (typeof result === 'string') return NextResponse.json({ error: result }, { status: 400 });

  return NextResponse.json({
    ok: true,
    mime: result.mime,
    byteSize: result.buffer.length,
    dataBase64: result.buffer.toString('base64'),
    maxBytes: SHOP_IMAGE_MAX_BYTES,
  });
}
