import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { canManageRepeatKanbanSettings } from '@/lib/auth/modulesAccess';
import { mergePreview } from '@/features/customers/engine/merge';

// Склейка заказчиков (миграция 243) — сводка для админов перед включением флага customer_merge:
// сколько пар склеится автоматически, сколько ручных решений, примеры (в т.ч. Хорев).
export const dynamic = 'force-dynamic';

export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!canManageRepeatKanbanSettings(session)) return NextResponse.json({ error: 'Только администраторам' }, { status: 403 });
  try {
    return NextResponse.json(await mergePreview(), { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) {
    console.error('[repeat-kanban merge preview]', e instanceof Error ? e.message : e);
    return NextResponse.json({ error: 'Не удалось собрать' }, { status: 500 });
  }
}
