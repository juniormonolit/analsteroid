import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { superadminError } from '@/lib/auth/perms';
import { analyticsDb, systemDb } from '@/lib/db/clients';
import {
  loadPriceStageMarkup, invalidatePriceStageMarkupCache,
  PRICE_STAGE_STATES, type PriceStageState,
} from '@/lib/settings/priceStageMarkup';

// «Цена: разметка стадий» (задача владельца 01.09, миграция 196) — какие стадии
// означают «цена озвучена». Только супер-админ (влияет на метрики всей компании,
// как режим дневного плана). Стадии — из живого справочника sa.stages: новые
// стадии Битрикса появляются тут сами, без миграций; без записи в разметке
// считаются 'no_price' и подсвечиваются бейджем «не размечена».
export async function GET() {
  const session = await getSession();
  const denied = superadminError(session);
  if (denied) return denied;

  const [stagesRes, markup] = await Promise.all([
    analyticsDb().query<{
      id: string; name: string; sort_order: number;
      funnel_id: number; funnel_name: string; is_repeat: boolean;
    }>(
      `SELECT s.id, s.name, s.sort_order, f.id AS funnel_id, f.name AS funnel_name, f.is_repeat
         FROM stages s JOIN funnels f ON f.id = s.funnel_id
        ORDER BY f.id, s.sort_order, s.id`,
    ),
    loadPriceStageMarkup(),
  ]);

  const stages = stagesRes.rows.map(s => ({
    id: s.id,
    name: s.name,
    funnelId: s.funnel_id,
    funnelName: s.funnel_name,
    isRepeat: s.is_repeat,
    state: (markup.get(s.id) ?? 'no_price') as PriceStageState,
    unmarked: !markup.has(s.id),
  }));
  return NextResponse.json({ stages });
}

export async function PUT(req: NextRequest) {
  const session = await getSession();
  const denied = superadminError(session);
  if (denied) return denied;

  const body = await req.json() as { stageId?: unknown; state?: unknown };
  const stageId = typeof body.stageId === 'string' ? body.stageId.slice(0, 64) : '';
  const state = body.state as PriceStageState;
  if (!stageId || !PRICE_STAGE_STATES.includes(state)) {
    return NextResponse.json({ error: 'Ожидаются stageId и state из no_price|has_price|unclear' }, { status: 400 });
  }

  await systemDb().query(
    `INSERT INTO stage_price_markup (stage_id, state) VALUES ($1, $2)
     ON CONFLICT (stage_id) DO UPDATE SET state = EXCLUDED.state, updated_at = now()`,
    [stageId, state],
  );
  invalidatePriceStageMarkupCache();
  return NextResponse.json({ ok: true, stageId, state });
}
