import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { permError } from '@/lib/auth/perms';
import { runOrgSync } from '@/lib/org/sync';

// Кнопка «Синхронизировать оргструктуру» (задача Серёги 13.07) и ночной cron
// 04:00 МСК дёргают этот роут. Тянет департаменты + сотрудников из Битрикса
// (BITRIX_ORG_WEBHOOK) в схему sa. Право — управление пользователями (админ).
export async function POST() {
  const session = await getSession();
  const denied = permError(session, 'action.users.manage');
  if (denied) return denied;

  try {
    const result = await runOrgSync();
    return NextResponse.json(result);
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Не удалось синхронизировать оргструктуру';
    console.error('[org-sync] failed:', msg);
    return NextResponse.json({ ok: false, error: msg }, { status: 502 });
  }
}
