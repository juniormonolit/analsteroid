import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { superadminError } from '@/lib/auth/perms';
import { systemDb } from '@/lib/db/clients';
import { loadQuestSettings, type QuestTier } from '@/features/quests/engine/quests';

// Настройки квестов (миграция 125): номиналы наград (база = синий тир),
// множители тиров, цены реролла/докупа, XP-множитель. Только супер-админ.

export async function GET() {
  const session = await getSession();
  const err = superadminError(session);
  if (err) return err;
  return NextResponse.json({ settings: await loadQuestSettings(systemDb()) });
}

const FIELDS: Record<string, { col: string; min: number; max: number }> = {
  rewardDay: { col: 'reward_day', min: 0, max: 10000 },
  rewardWeek: { col: 'reward_week', min: 0, max: 10000 },
  rewardMonth: { col: 'reward_month', min: 0, max: 10000 },
  xpMult: { col: 'xp_mult', min: 0, max: 100 },
  rerollDay: { col: 'reroll_day', min: 0, max: 10000 },
  rerollWeek: { col: 'reroll_week', min: 0, max: 10000 },
  rerollMonth: { col: 'reroll_month', min: 0, max: 10000 },
  extraDay: { col: 'extra_day', min: 0, max: 10000 },
};
const TIERS: QuestTier[] = ['white', 'green', 'blue', 'epic', 'legendary'];

export async function PATCH(req: Request) {
  const session = await getSession();
  const err = superadminError(session);
  if (err) return err;
  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Некорректный JSON' }, { status: 400 }); }

  const sets: string[] = [];
  const params: unknown[] = [];
  for (const [k, spec] of Object.entries(FIELDS)) {
    if (body[k] === undefined) continue;
    const v = Number(body[k]);
    if (!Number.isFinite(v) || v < spec.min || v > spec.max) {
      return NextResponse.json({ error: `${k}: число от ${spec.min} до ${spec.max}` }, { status: 400 });
    }
    params.push(v);
    sets.push(`${spec.col} = $${params.length}`);
  }
  if (body.tierMult !== undefined) {
    const tm = body.tierMult as Record<string, unknown>;
    const clean: Record<string, number> = {};
    for (const t of TIERS) {
      const v = Number(tm?.[t]);
      if (!Number.isFinite(v) || v < 0 || v > 100) {
        return NextResponse.json({ error: `tierMult.${t}: число от 0 до 100` }, { status: 400 });
      }
      clean[t] = v;
    }
    params.push(JSON.stringify(clean));
    sets.push(`tier_mult = $${params.length}::jsonb`);
  }
  if (sets.length > 0) {
    await systemDb().query(`UPDATE quest_settings SET ${sets.join(', ')}, updated_at = now() WHERE id = 1`, params);
  }
  return NextResponse.json({ ok: true });
}
