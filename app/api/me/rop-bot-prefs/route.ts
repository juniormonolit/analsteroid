import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { systemDb } from '@/lib/db/clients';
import { DEFAULT_ROP_BOT_PREFS, fetchRopBotPrefs, isActiveRop } from '@/lib/jobs/ropDigest';

// Личные настройки подписки РОПа на дайджест «Аналитика» по отделу (задача
// 2769, по образцу app/api/me/bot-prefs/route.ts из 2765 — «это его личка»,
// только предмет другой: не персональные советы по клиентам, а дайджест
// отдела). ТОЛЬКО свои — bitrixId из СЕССИИ, подделать чужой нельзя.
//
// isRop — есть ли у этого bitrix-пользователя прямой подчинённый прямо сейчас
// (sa.org_resolved_hierarchy.rop_bitrix_user_id) — гейт для UI: показывать
// блок вообще только реальным РОПам (директор без прямых подчинённых просто
// не увидит панель, ему нечем управлять).

export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!session.bitrixUserId) return NextResponse.json({ prefs: DEFAULT_ROP_BOT_PREFS, hasBitrix: false, isRop: false });
  const bitrixId = Number(session.bitrixUserId);
  const [prefs, isRop] = await Promise.all([fetchRopBotPrefs(bitrixId), isActiveRop(bitrixId)]);
  return NextResponse.json({ prefs, hasBitrix: true, isRop });
}

const FIELDS: { key: keyof typeof DEFAULT_ROP_BOT_PREFS; col: string }[] = [
  { key: 'enabled', col: 'enabled' },
  { key: 'dailyDigest', col: 'daily_digest' },
  { key: 'weeklyDigest', col: 'weekly_digest' },
  { key: 'showNumbers', col: 'show_numbers' },
  { key: 'showHints', col: 'show_hints' },
];

export async function PATCH(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!session.bitrixUserId) {
    return NextResponse.json({ error: 'no_bitrix', message: 'К аккаунту не привязан Bitrix — настройки дайджеста недоступны' }, { status: 400 });
  }
  const bitrixId = Number(session.bitrixUserId);

  const body = await req.json().catch(() => null) as Record<string, unknown> | null;
  if (!body) return NextResponse.json({ error: 'Некорректный запрос' }, { status: 400 });

  const current = await fetchRopBotPrefs(bitrixId);
  const next = { ...current };
  for (const f of FIELDS) {
    if (body[f.key] !== undefined) next[f.key] = Boolean(body[f.key]);
  }

  const cols = FIELDS.map(f => f.col).join(', ');
  const placeholders = FIELDS.map((_, i) => `$${i + 2}`).join(', ');
  const updates = FIELDS.map(f => `${f.col} = EXCLUDED.${f.col}`).join(', ');
  await systemDb().query(
    `INSERT INTO rop_bot_prefs (bitrix_id, ${cols}, updated_at)
     VALUES ($1, ${placeholders}, now())
     ON CONFLICT (bitrix_id) DO UPDATE SET ${updates}, updated_at = now()`,
    [bitrixId, ...FIELDS.map(f => next[f.key])],
  );
  return NextResponse.json({ ok: true, prefs: next });
}
