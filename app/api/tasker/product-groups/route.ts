// Задачник: справочник товарных групп (шкала kc, как отчёт «По товарным группам») для форм обучения и задачи —
// выбор «материалы по товарной группе» без конструктора тем (тема заводится при сохранении, engine/topics.ts).
import { NextResponse } from 'next/server';
import { taskerAuth } from '@/features/tasker/engine/http';
import { errorResponse } from '@/features/tasker/engine/config';
import { productGroupOptions } from '@/features/tasker/engine/topics';

export const dynamic = 'force-dynamic';

export async function GET() {
  const auth = await taskerAuth();
  if (auth instanceof Response) return auth;
  try {
    return NextResponse.json({ groups: await productGroupOptions() });
  } catch (e) {
    return errorResponse(e);
  }
}
