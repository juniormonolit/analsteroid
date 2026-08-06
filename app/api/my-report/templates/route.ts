// Шаблоны конструктора «Мой отчёт»: пресеты по роли + личные.
//
//   GET    — пресеты (считаются на запрос по доступным отделам) + личные шаблоны;
//   POST   — сохранить/перезаписать личный шаблон по имени;
//   DELETE — удалить личный (?id=…). Пресет удалить нельзя — его нет в БД.
//
// Устойчивость к отсутствию таблицы — намеренно. Миграция 156 применяется на
// двух стендах вручную, и до её прогона раздел обязан РАБОТАТЬ: пресеты по роли
// закрывают главное требование владельца («ноль действий для того, кому сойдёт
// стандартный отчёт»), а личные шаблоны просто ещё недоступны. Молча падать 500
// на весь раздел из-за ненакатанной миграции — хуже. Тот же приём, что в
// lib/metrics/catalog.ts с metric_colors.

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { systemDb } from '@/lib/db/clients';
import {
  parseTemplateState,
  rolePresets,
  type ReportTemplate,
} from '@/lib/reports-builder/presets';

/** true — таблицы ещё нет (миграция 156 не накатана). */
function isMissingTable(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === '42P01';
}

interface TemplateRow {
  id: string;
  name: string;
  state: unknown;
  is_default: boolean;
}

async function loadPersonal(userLogin: string): Promise<{ templates: ReportTemplate[]; storageReady: boolean }> {
  try {
    const res = await systemDb().query<TemplateRow>(
      `SELECT id::text, name, state, is_default
         FROM report_templates WHERE user_login = $1 ORDER BY created_at`,
      [userLogin],
    );
    const templates: ReportTemplate[] = [];
    for (const row of res.rows) {
      const state = parseTemplateState(row.state);
      // Битую запись пропускаем, а не роняем список: один сломанный шаблон не
      // должен лишать человека остальных.
      if (!state) continue;
      templates.push({ id: row.id, name: row.name, kind: 'personal', isDefault: row.is_default, state });
    }
    return { templates, storageReady: true };
  } catch (err) {
    if (isMissingTable(err)) return { templates: [], storageReady: false };
    throw err;
  }
}

export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const [presets, personal] = await Promise.all([rolePresets(session), loadPersonal(session.login)]);
  return NextResponse.json({
    templates: [...personal.templates, ...presets],
    storageReady: personal.storageReady,
  });
}

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const name = String(body.name ?? '').trim();
  if (!name || name.length > 80) return NextResponse.json({ error: 'Название 1..80 символов' }, { status: 400 });
  const state = parseTemplateState(body.state);
  if (!state) return NextResponse.json({ error: 'Некорректное состояние шаблона' }, { status: 400 });
  const isDefault = body.isDefault === true;

  try {
    const db = systemDb();
    if (isDefault) {
      // Один шаблон по умолчанию на человека — снимаем флаг с прежнего ДО вставки,
      // иначе частичный уникальный индекс отдаст 23505 вместо переключения.
      await db.query(`UPDATE report_templates SET is_default = false WHERE user_login = $1 AND is_default`, [session.login]);
    }
    const res = await db.query<{ id: string }>(
      `INSERT INTO report_templates (user_login, name, state, is_default)
            VALUES ($1, $2, $3::jsonb, $4)
       ON CONFLICT (user_login, name)
         DO UPDATE SET state = EXCLUDED.state, is_default = EXCLUDED.is_default, updated_at = now()
       RETURNING id::text`,
      [session.login, name, JSON.stringify(state), isDefault],
    );
    return NextResponse.json({ id: res.rows[0].id, name, kind: 'personal', isDefault, state });
  } catch (err) {
    if (isMissingTable(err)) {
      return NextResponse.json(
        { error: 'Хранилище шаблонов ещё не готово (миграция 156 не применена)' },
        { status: 503 },
      );
    }
    throw err;
  }
}

export async function DELETE(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const id = req.nextUrl.searchParams.get('id') ?? '';
  if (!/^[0-9a-f-]{36}$/i.test(id)) return NextResponse.json({ error: 'id обязателен' }, { status: 400 });

  try {
    // user_login в WHERE — чужой шаблон не удалить даже с подобранным id.
    const res = await systemDb().query(
      `DELETE FROM report_templates WHERE id = $1::uuid AND user_login = $2`,
      [id, session.login],
    );
    if (res.rowCount === 0) return NextResponse.json({ error: 'Шаблон не найден' }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (isMissingTable(err)) return NextResponse.json({ error: 'Шаблон не найден' }, { status: 404 });
    throw err;
  }
}
