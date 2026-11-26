import { NextResponse } from 'next/server';
import { myTests } from '@/features/tasker/tests/engine';
import type { MyTestsResponse } from '@/features/tasker/tests/types';
import { NO_STORE, withSelf } from '../_shared';

// ЛК: мои тесты (назначенные и пройденные) + счётчик для пункта меню.
export const dynamic = 'force-dynamic';

export async function GET() {
  return withSelf('my', async session => NextResponse.json((await myTests(session)) satisfies MyTestsResponse, { headers: NO_STORE }));
}
