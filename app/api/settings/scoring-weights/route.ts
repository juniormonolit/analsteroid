import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { superadminError } from '@/lib/auth/perms';
import { systemDb } from '@/lib/db/clients';
import {
  AXIS_KEYS, invalidateScoringWeightsCache, getRawScoringWeights, type AxisKey,
} from '@/lib/settings/scoringWeights';

// Веса скоринга «Карточка менеджера v2» (бриф 10.07, п.4) — настройка супер-админа,
// хранится в scoring_weights (singleton id=1, миграция 068). Тот же паттерн, что
// /api/settings/daily-plan-mode: и GET, и PUT гейтятся superadminError (страница
// /settings/scoring-weights и без того не в навигации для остальных ролей — гейт
// API дублирует проверку на случай прямого запроса).
export async function GET() {
  const session = await getSession();
  const denied = superadminError(session);
  if (denied) return denied;

  const raw = await getRawScoringWeights();
  return NextResponse.json({ weights: raw });
}

export async function PUT(req: NextRequest) {
  const session = await getSession();
  const denied = superadminError(session);
  if (denied) return denied;

  const body = await req.json().catch(() => ({}));
  const weights = body.weights as Record<string, unknown> | undefined;
  if (!weights || typeof weights !== 'object') {
    return NextResponse.json({ error: 'weights обязателен (объект по 6 осям)' }, { status: 400 });
  }

  const values: Record<AxisKey, number> = {} as Record<AxisKey, number>;
  for (const key of AXIS_KEYS) {
    const v = Number(weights[key]);
    if (!Number.isFinite(v) || v < 0 || v > 10) {
      return NextResponse.json({ error: `Вес ${key} должен быть числом 0-10` }, { status: 400 });
    }
    values[key] = v;
  }

  await systemDb().query(
    `UPDATE scoring_weights SET
       cr_deal_to_reservation = $1, cr_reservation_to_sale = $2, sales_amount = $3,
       avg_check = $4, touch_speed = $5, refusal_rate = $6, updated_at = NOW()
     WHERE id = 1`,
    AXIS_KEYS.map(k => values[k]),
  );
  invalidateScoringWeightsCache();
  return NextResponse.json({ ok: true, weights: values });
}
