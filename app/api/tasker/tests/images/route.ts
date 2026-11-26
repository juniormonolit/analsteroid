// Картинка к вопросу теста (multipart `file`) — в общую таблицу картинок Задачника (миграция 280), отдаётся
// GET /api/tasker/templates/images/<uuid>. Грузит тот, кто ведёт тесты.
import { NextRequest, NextResponse } from 'next/server';
import { saveTemplateImage } from '@/features/tasker/engine/templates';
import { withTestActor } from '../_shared';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  return withTestActor('image', async actor => {
    if (!actor.canManage) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    const form = await req.formData().catch(() => null);
    const file = form?.get('file');
    if (!file || typeof file !== 'object' || !('arrayBuffer' in file)) return NextResponse.json({ error: 'Нет файла' }, { status: 400 });
    try {
      return NextResponse.json(await saveTemplateImage(actor.session, file as File));
    } catch (e) {
      return NextResponse.json({ error: e instanceof Error ? e.message : 'Не удалось сохранить картинку' }, { status: 400 });
    }
  });
}
