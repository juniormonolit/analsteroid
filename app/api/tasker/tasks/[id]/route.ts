// Задачник: смена статуса (перетаскивание по доске → Битрикс) и перенос слота/срока.
import { NextRequest, NextResponse } from 'next/server';
import { taskerAuth, intParam } from '@/features/tasker/engine/http';
import { patchTask } from '@/features/tasker/engine/patch';
import { errorResponse } from '@/features/tasker/engine/config';
import type { TaskerPatchResponse } from '@/features/tasker/types';

export const dynamic = 'force-dynamic';

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await taskerAuth();
  if (auth instanceof Response) return auth;
  const id = intParam((await params).id);
  if (!id) return NextResponse.json({ error: 'Некорректный id', code: 'bad_request' }, { status: 400 });
  try {
    const body = await req.json().catch(() => null);
    const { task, warning } = await patchTask(auth.session, auth.scope, id, body);
    const out: TaskerPatchResponse = { task, warning };
    return NextResponse.json(out);
  } catch (e) {
    return errorResponse(e);
  }
}
