// Задачник: кого можно указать постановщиком (поле «Постановщик» формы). Правило — features/tasker/engine/creators.ts.
import { NextRequest, NextResponse } from 'next/server';
import { taskerAuth } from '@/features/tasker/engine/http';
import { errorResponse, loadSettings } from '@/features/tasker/engine/config';
import { creatorOptions } from '@/features/tasker/engine/creators';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const auth = await taskerAuth('action.tasker.assign');
  if (auth instanceof Response) return auth;
  try {
    const ids = (req.nextUrl.searchParams.get('managerIds') ?? '')
      .split(',').map(s => s.trim()).filter(s => /^\d+$/.test(s)).slice(0, 30);
    return NextResponse.json(await creatorOptions(auth.session, auth.scope, await loadSettings(), ids));
  } catch (e) {
    return errorResponse(e);
  }
}
