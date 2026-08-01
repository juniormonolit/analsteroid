import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { superadminError } from '@/lib/auth/perms';
import { systemDb } from '@/lib/db/clients';
import { loadXpSettings, loadClassMap, OTHER_CLASS } from '@/features/xp/engine/xp';

// Настройки XP-системы (миграция 124, «Настройки → Награды → XP»): коэффициенты
// начисления + маппинг «головная группа → класс». Только супер-админ.
// Пересчёт после правок — общей кнопкой «Пересчитать награды»
// (POST /api/badges/recompute — XP-леджер пересчитывается тем же тиком).

export async function GET() {
  const session = await getSession();
  const err = superadminError(session);
  if (err) return err;
  const db = systemDb();
  const [settings, map] = await Promise.all([loadXpSettings(db), loadClassMap(db)]);
  return NextResponse.json({
    settings,
    classMap: Object.fromEntries(map),
    otherClass: OTHER_CLASS,
  });
}

// Числовые поля настроек: колонка БД → допустимый диапазон.
const FIELDS: Record<string, { col: string; min: number; max: number }> = {
  saleFix: { col: 'sale_fix', min: 0, max: 10000 },
  salePerRub: { col: 'sale_per_rub', min: 1, max: 100_000_000 },
  saleSumCap: { col: 'sale_sum_cap', min: 0, max: 100000 },
  shipFix: { col: 'ship_fix', min: 0, max: 10000 },
  shipPerRub: { col: 'ship_per_rub', min: 1, max: 100_000_000 },
  shipSumCap: { col: 'ship_sum_cap', min: 0, max: 100000 },
  repeatMult: { col: 'repeat_mult', min: 1, max: 10 },
  crosssellMult: { col: 'crosssell_mult', min: 1, max: 10 },
  regularBonus: { col: 'regular_bonus', min: 0, max: 100000 },
  speedBonus: { col: 'speed_bonus', min: 0, max: 5 },
  levelBase: { col: 'level_base', min: 1, max: 1_000_000 },
  levelExp: { col: 'level_exp', min: 1, max: 3 },
  classLevelBase: { col: 'class_level_base', min: 1, max: 1_000_000 },
};

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
  if (sets.length > 0) {
    await systemDb().query(`UPDATE xp_settings SET ${sets.join(', ')}, updated_at = now() WHERE id = 1`, params);
  }

  // Маппинг классов: полная замена присланных пар {head_group: class_name};
  // пустое имя класса = убрать группу из маппинга (уйдёт в «Прочее»).
  if (body.classMap !== undefined) {
    if (typeof body.classMap !== 'object' || body.classMap === null || Array.isArray(body.classMap)) {
      return NextResponse.json({ error: 'classMap: объект {группа: класс}' }, { status: 400 });
    }
    const entries = Object.entries(body.classMap as Record<string, unknown>);
    if (entries.length > 500) return NextResponse.json({ error: 'classMap: слишком много записей' }, { status: 400 });
    const client = await systemDb().connect();
    try {
      await client.query('BEGIN');
      for (const [group, cls] of entries) {
        const g = group.trim().slice(0, 200);
        const c = typeof cls === 'string' ? cls.trim().slice(0, 100) : '';
        if (!g) continue;
        if (c === '') await client.query(`DELETE FROM xp_class_map WHERE head_group = $1`, [g]);
        else {
          await client.query(
            `INSERT INTO xp_class_map (head_group, class_name) VALUES ($1, $2)
             ON CONFLICT (head_group) DO UPDATE SET class_name = EXCLUDED.class_name`,
            [g, c],
          );
        }
      }
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  }
  return NextResponse.json({ ok: true });
}
