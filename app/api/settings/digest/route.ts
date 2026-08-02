import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { superadminError } from '@/lib/auth/perms';
import { systemDb } from '@/lib/db/clients';
import {
  DEFAULT_DIGEST_SETTINGS, fetchDigestSettings,
  DEFAULT_ADVICE_SCORING, fetchAdviceScoringSettings,
} from '@/lib/jobs/managerDigest';
import { fetchAdviceStats } from '@/lib/jobs/adviceFeedback';

// «Настройки → Геймификация → Дайджест» (задача 2765): вкл/выкл ежедневного и
// еженедельного дайджеста, час отправки (МСК), лимит напоминаний — singleton
// digest_settings (id=1, миграция 133), как daily-plan-mode/customer-categories.
// Плюс скоринг подсказок «кому звонить» (правка владельца 02.08 — «только
// реально высокошансовые») — веса факторов + порог отсечки + порог «мёртвых»
// (миграция 137, дефолты калиброваны бэктестом, см. комментарий в миграции и
// WORKLOG). Плюс сводная статистика попаданий (advice_log) — read-only.

export async function GET() {
  const session = await getSession();
  const denied = superadminError(session);
  if (denied) return denied;
  const [settings, scoring, stats] = await Promise.all([
    fetchDigestSettings(), fetchAdviceScoringSettings(), fetchAdviceStats(),
  ]);
  return NextResponse.json({
    settings, defaults: DEFAULT_DIGEST_SETTINGS,
    scoring, scoringDefaults: DEFAULT_ADVICE_SCORING,
    stats,
  });
}

const FIELDS: { key: keyof typeof DEFAULT_DIGEST_SETTINGS; col: string }[] = [
  { key: 'dailyEnabled', col: 'daily_enabled' },
  { key: 'weeklyEnabled', col: 'weekly_enabled' },
  { key: 'dailyHour', col: 'daily_hour' },
  { key: 'weeklyHour', col: 'weekly_hour' },
  { key: 'maxReminders', col: 'max_reminders' },
];

// Веса — произвольные положительные числа (не обязаны суммироваться в 100,
// это множители, не проценты); пороги — с разумными границами.
const SCORING_FIELDS: { key: keyof typeof DEFAULT_ADVICE_SCORING; col: string; min: number; max: number }[] = [
  { key: 'scoreThreshold', col: 'advice_score_threshold', min: 0, max: 100 },
  { key: 'weightRecency', col: 'weight_recency', min: 0, max: 100 },
  { key: 'weightFrequency', col: 'weight_frequency', min: 0, max: 100 },
  { key: 'weightValue', col: 'weight_value', min: 0, max: 100 },
  { key: 'weightResponsive', col: 'weight_responsive', min: 0, max: 100 },
  { key: 'weightCrosssell', col: 'weight_crosssell', min: 0, max: 100 },
  { key: 'deadRatioThreshold', col: 'dead_ratio_threshold', min: 1, max: 50 },
  { key: 'deadDaysThreshold', col: 'dead_days_threshold', min: 30, max: 3650 },
];

export async function PATCH(req: NextRequest) {
  const session = await getSession();
  const denied = superadminError(session);
  if (denied) return denied;

  const body = await req.json().catch(() => null) as Record<string, unknown> | null;
  if (!body) return NextResponse.json({ error: 'Некорректный запрос' }, { status: 400 });

  const sets: string[] = [];
  const params: unknown[] = [];
  for (const f of FIELDS) {
    const v = body[f.key];
    if (v === undefined) continue;
    if (f.key === 'dailyEnabled' || f.key === 'weeklyEnabled') {
      params.push(Boolean(v));
    } else {
      const num = Number(v);
      const max = f.key === 'maxReminders' ? 5 : 23;
      const min = f.key === 'maxReminders' ? 0 : 0;
      if (!Number.isInteger(num) || num < min || num > max) {
        return NextResponse.json({ error: `${f.key}: целое число от ${min} до ${max}` }, { status: 400 });
      }
      params.push(num);
    }
    sets.push(`${f.col} = $${params.length}`);
  }
  for (const f of SCORING_FIELDS) {
    const v = body[f.key];
    if (v === undefined) continue;
    const num = Number(v);
    if (!Number.isFinite(num) || num < f.min || num > f.max) {
      return NextResponse.json({ error: `${f.key}: число от ${f.min} до ${f.max}` }, { status: 400 });
    }
    params.push(num);
    sets.push(`${f.col} = $${params.length}`);
  }
  if (sets.length === 0) return NextResponse.json({ error: 'Нет полей для обновления' }, { status: 400 });
  params.push(session!.displayName);
  await systemDb().query(
    `UPDATE digest_settings SET ${sets.join(', ')}, updated_at = now(), updated_by = $${params.length} WHERE id = 1`,
    params,
  );
  return NextResponse.json({
    ok: true, settings: await fetchDigestSettings(), scoring: await fetchAdviceScoringSettings(),
  });
}
