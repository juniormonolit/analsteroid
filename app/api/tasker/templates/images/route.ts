// Задачник: загрузка картинки для шаблона рекомендаций (multipart `file`) → абсолютная ссылка, которую
// редактор вставляет в текст как [IMG]…[/IMG]. Байты — в БД (миграция 280).
import { NextRequest, NextResponse } from 'next/server';
import { taskerAuth } from '@/features/tasker/engine/http';
import { errorResponse } from '@/features/tasker/engine/config';
import { canManageTemplates, saveTemplateImage } from '@/features/tasker/engine/templates';
import type { TaskerTemplateImageResponse } from '@/features/tasker/types';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const auth = await taskerAuth();
  if (auth instanceof Response) return auth;
  if (!canManageTemplates(auth.session)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  const form = await req.formData().catch(() => null);
  const file = form?.get('file');
  if (!file || typeof file !== 'object' || !('arrayBuffer' in file)) return NextResponse.json({ error: 'Нет файла' }, { status: 400 });
  try {
    const out: TaskerTemplateImageResponse = await saveTemplateImage(auth.session, file as File);
    return NextResponse.json(out);
  } catch (e) {
    return errorResponse(e);
  }
}
