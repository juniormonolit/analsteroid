import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { superadminError } from '@/lib/auth/perms';
import { systemDb } from '@/lib/db/clients';
import { templateFromDb, validateTemplate, type QuestTemplate } from '@/features/quests/engine/templates';
import { listQuestableMetrics, resolveQuestMetric } from '@/features/quests/engine/metricQuests';

// Конструктор квестов (задача 60, миграция 164): шаблоны выдачи + справочник
// метрик каталога, на которых квест можно построить. Только супер-админ —
// шаблон печатает деньги, доступ такой же, как у остальных настроек наград.

const COLS = `id, enabled, name, kind, category, metric_id, period_type, target_mode,
  target_fixed, target_floor, target_ceiling, reward_eballs, weight, audience, title_template`;

function toApi(t: QuestTemplate) { return t; }

export async function GET() {
  const session = await getSession();
  const err = superadminError(session);
  if (err) return err;
  const db = systemDb();
  try {
    const [rows, metrics] = await Promise.all([
      db.query<Record<string, unknown>>(`SELECT ${COLS} FROM quest_templates ORDER BY period_type, weight DESC, id`),
      listQuestableMetrics(),
    ]);
    return NextResponse.json({
      templates: rows.rows.map(r => toApi(templateFromDb(r))),
      metrics: metrics.map(m => ({
        id: m.id, name: m.nameRu, category: m.category, dataType: m.dataType,
      })),
    });
  } catch (e) {
    // Таблицы ещё нет (миграция 164 не накатана) — отдаём пустой конструктор,
    // а не 500: страница настроек не должна падать целиком из-за одной вкладки.
    console.warn('[quest-templates] GET:', e instanceof Error ? e.message : e);
    return NextResponse.json({ templates: [], metrics: [], error: 'Таблица шаблонов недоступна — нужна миграция 164' });
  }
}

export async function POST(req: Request) {
  const session = await getSession();
  const err = superadminError(session);
  if (err) return err;
  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Некорректный JSON' }, { status: 400 }); }

  const v = validateTemplate(body);
  if (!v.ok) return NextResponse.json({ error: v.error }, { status: 400 });
  const t = v.value;
  if (t.kind === 'metric' && t.metricId) {
    // Метрику проверяем не по списку id, а движком: он же решает, поддержана ли
    // она универсальным вычислителем. Иначе шаблон завёлся бы, а квест по нему
    // молча висел бы на нуле.
    if (!(await resolveQuestMetric(t.metricId))) {
      return NextResponse.json({ error: 'Эта метрика не поддержана квестами (нужна collected по сделкам или формула поверх таких)' }, { status: 400 });
    }
  }
  const db = systemDb();
  const r = await db.query<Record<string, unknown>>(
    `INSERT INTO quest_templates (enabled, name, kind, category, metric_id, period_type, target_mode,
       target_fixed, target_floor, target_ceiling, reward_eballs, weight, audience, title_template)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14)
     RETURNING ${COLS}`,
    [t.enabled, t.name, t.kind, t.category, t.metricId, t.periodType, t.targetMode,
      t.targetFixed, t.targetFloor, t.targetCeiling, t.rewardEballs, t.weight,
      JSON.stringify(t.audience), t.titleTemplate],
  );
  return NextResponse.json({ template: toApi(templateFromDb(r.rows[0])) });
}

export async function PATCH(req: Request) {
  const session = await getSession();
  const err = superadminError(session);
  if (err) return err;
  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Некорректный JSON' }, { status: 400 }); }
  const id = Number(body.id);
  if (!Number.isInteger(id) || id <= 0) return NextResponse.json({ error: 'Не указан шаблон' }, { status: 400 });

  const db = systemDb();
  // Быстрый путь «щёлкнуть галочку»: тело только с id и enabled не требует
  // пересборки всей формы.
  if (Object.keys(body).length === 2 && body.enabled !== undefined) {
    const r = await db.query<Record<string, unknown>>(
      `UPDATE quest_templates SET enabled=$2, updated_at=now() WHERE id=$1 RETURNING ${COLS}`,
      [id, Boolean(body.enabled)],
    );
    if (r.rows.length === 0) return NextResponse.json({ error: 'Шаблон не найден' }, { status: 404 });
    return NextResponse.json({ template: toApi(templateFromDb(r.rows[0])) });
  }

  const v = validateTemplate(body);
  if (!v.ok) return NextResponse.json({ error: v.error }, { status: 400 });
  const t = v.value;
  if (t.kind === 'metric' && t.metricId && !(await resolveQuestMetric(t.metricId))) {
    return NextResponse.json({ error: 'Эта метрика не поддержана квестами' }, { status: 400 });
  }
  const r = await db.query<Record<string, unknown>>(
    `UPDATE quest_templates SET enabled=$2, name=$3, kind=$4, category=$5, metric_id=$6,
       period_type=$7, target_mode=$8, target_fixed=$9, target_floor=$10, target_ceiling=$11,
       reward_eballs=$12, weight=$13, audience=$14::jsonb, title_template=$15, updated_at=now()
     WHERE id=$1 RETURNING ${COLS}`,
    [id, t.enabled, t.name, t.kind, t.category, t.metricId, t.periodType, t.targetMode,
      t.targetFixed, t.targetFloor, t.targetCeiling, t.rewardEballs, t.weight,
      JSON.stringify(t.audience), t.titleTemplate],
  );
  if (r.rows.length === 0) return NextResponse.json({ error: 'Шаблон не найден' }, { status: 404 });
  return NextResponse.json({ template: toApi(templateFromDb(r.rows[0])) });
}

export async function DELETE(req: Request) {
  const session = await getSession();
  const err = superadminError(session);
  if (err) return err;
  const id = Number(new URL(req.url).searchParams.get('id'));
  if (!Number.isInteger(id) || id <= 0) return NextResponse.json({ error: 'Не указан шаблон' }, { status: 400 });
  const db = systemDb();
  // Уже выданные по шаблону квесты НЕ трогаем: они живут своей жизнью
  // (прогресс считается по metric_id из строки квеста), просто теряют ссылку.
  await db.query(`UPDATE quests SET template_id = NULL WHERE template_id = $1`, [id]);
  await db.query(`DELETE FROM quest_templates WHERE id = $1`, [id]);
  return NextResponse.json({ ok: true });
}
