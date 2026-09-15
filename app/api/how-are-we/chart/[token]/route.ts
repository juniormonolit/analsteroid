import { NextResponse } from 'next/server';
import { loadChart } from '@/features/how-are-we/engine/chart';

// Картинка дайджеста «Как дела?» для превью в чате Битрикса. Без сессии
// намеренно: Битрикс скачивает её своим сервером. Защита — одноразовый
// 128-битный токен и срок жизни 72 ч; по адресу нет ничего, кроме графика,
// который получатели и так видят в сообщении.
export async function GET(_req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  const png = await loadChart(token);
  if (!png) return new NextResponse('Not found', { status: 404 });
  return new NextResponse(new Uint8Array(png), {
    headers: { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=259200, immutable', 'Content-Length': String(png.length) },
  });
}
