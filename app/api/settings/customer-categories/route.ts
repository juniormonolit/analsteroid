import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { superadminError } from '@/lib/auth/perms';
import { systemDb } from '@/lib/db/clients';
import { DEFAULT_CATEGORY_SETTINGS, fetchCategorySettings } from '@/features/customers/engine/customers';

// Пороги категорий клиентов (дополнение Серёги 01.08, миграция 129) —
// singleton id=1, редактирует только супер-админ (как daily-plan-mode).
// Категория считается на лету поверх кэша списка — правка действует сразу.

export async function GET() {
  const session = await getSession();
  const denied = superadminError(session);
  if (denied) return denied;
  return NextResponse.json({ settings: await fetchCategorySettings(), defaults: DEFAULT_CATEGORY_SETTINGS });
}

const FIELDS: { key: keyof typeof DEFAULT_CATEGORY_SETTINGS; col: string; min: number; max: number }[] = [
  { key: 'keyMinShipments', col: 'key_min_shipments', min: 1, max: 1000 },
  { key: 'keyMinSum', col: 'key_min_sum', min: 0, max: 10_000_000_000 },
  { key: 'largeMinSum', col: 'large_min_sum', min: 0, max: 10_000_000_000 },
  { key: 'largeMinShipments', col: 'large_min_shipments', min: 1, max: 1000 },
  { key: 'complexMinGroups', col: 'complex_min_groups', min: 2, max: 50 },
  { key: 'frequentFactor', col: 'frequent_factor', min: 0.05, max: 1 },
  { key: 'fadingFactor', col: 'fading_factor', min: 1, max: 20 },
];

export async function PUT(req: NextRequest) {
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
    `UPDATE customer_category_settings SET ${sets.join(', ')}, updated_at = now(), updated_by = $${params.length} WHERE id = 1`,
    params,
  );
  return NextResponse.json({ ok: true, settings: await fetchCategorySettings() });
}
