import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { systemDb } from '@/lib/db/clients';
import { DEFAULT_MANAGER_BOT_PREFS, fetchManagerBotPrefs } from '@/lib/jobs/managerDigest';

// Личные настройки подписки на бота «Аналитик» (задача 2765, правка владельца
// 02.08: «это его личка»). ТОЛЬКО свои — bitrixId берётся из СЕССИИ, никакого
// параметра «чей аккаунт» в запросе нет: подделать чужой id нельзя. РОП и
// админ не могут отредактировать это через данный роут в принципе (см.
// app/api/settings/subscriptions/route.ts — там read-only и по отдельному
// праву action.subscriptions.view_all).

export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!session.bitrixUserId) return NextResponse.json({ prefs: DEFAULT_MANAGER_BOT_PREFS, hasBitrix: false });
  const prefs = await fetchManagerBotPrefs(Number(session.bitrixUserId));
  return NextResponse.json({ prefs, hasBitrix: true });
}

const FIELDS: { key: keyof typeof DEFAULT_MANAGER_BOT_PREFS; col: string }[] = [
  { key: 'enabled', col: 'enabled' },
  { key: 'dailyDigest', col: 'daily_digest' },
  { key: 'weeklyDigest', col: 'weekly_digest' },
  { key: 'adviceCustomers', col: 'advice_customers' },
  { key: 'adviceNumbers', col: 'advice_numbers' },
];

export async function PATCH(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!session.bitrixUserId) {
    return NextResponse.json({ error: 'no_bitrix', message: 'К аккаунту не привязан Bitrix — настройки подписки недоступны' }, { status: 400 });
  }
  const bitrixId = Number(session.bitrixUserId);

  const body = await req.json().catch(() => null) as Record<string, unknown> | null;
  if (!body) return NextResponse.json({ error: 'Некорректный запрос' }, { status: 400 });

  const current = await fetchManagerBotPrefs(bitrixId);
  const next = { ...current };
  for (const f of FIELDS) {
    if (body[f.key] !== undefined) next[f.key] = Boolean(body[f.key]);
  }

  const cols = FIELDS.map(f => f.col).join(', ');
  const placeholders = FIELDS.map((_, i) => `$${i + 2}`).join(', ');
  const updates = FIELDS.map(f => `${f.col} = EXCLUDED.${f.col}`).join(', ');
  await systemDb().query(
    `INSERT INTO manager_bot_prefs (bitrix_id, ${cols}, updated_at)
     VALUES ($1, ${placeholders}, now())
     ON CONFLICT (bitrix_id) DO UPDATE SET ${updates}, updated_at = now()`,
    [bitrixId, ...FIELDS.map(f => next[f.key])],
  );
  return NextResponse.json({ ok: true, prefs: next });
}
