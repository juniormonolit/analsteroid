import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { isReportAdmin } from '@/lib/auth/perms';
import { systemDb } from '@/lib/db/clients';

// Ручной порядок в сайдбаре (правка владельца 10.07, migration 077). Два режима:
//
// 1. body = { direction: 'up'|'down' } — «вверх»/«вниз» (стрелки): меняет местами
//    sort_order текущей строки и соседней (в том же скоупе — своя витрина ИЛИ личный
//    список этого же пользователя). На краю списка (нет соседа) — no-op, отвечаем 200
//    без изменений (кнопка на клиенте в этот момент и так задизейблена по
//    isFirst/isLast, но сервер — источник правды, не полагается на UI-состояние).
//
// 2. body = { beforeId: string|null } — drag-and-drop (правка владельца 10.07/2):
//    поставить отчёт [id] НЕПОСРЕДСТВЕННО ПЕРЕД отчётом beforeId того же скоупа;
//    beforeId: null = в конец списка. Сервер читает весь скоуп в текущем порядке,
//    вычисляет новую последовательность и перенумеровывает 1..N ОДНИМ UPDATE
//    (bulk — не запрос на строку). Заодно это самовосстанавливает возможные дубли
//    sort_order (backfill 077 нумеровал только живые строки — восстановление из
//    корзины может вернуть строку с задублированным номером).
//
// Права в обоих режимах те же, что у PATCH/PUT/DELETE того же отчёта: свой личный —
// владелец, витринный («Роп монитор»/«Смекалочная») — любой админ
// (action.shared_reports.manage).
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { id } = await params;
  const body: { direction?: 'up' | 'down'; beforeId?: string | null } = await req.json();
  const isDnd = 'beforeId' in body;
  if (!isDnd && body.direction !== 'up' && body.direction !== 'down') {
    return NextResponse.json({ error: 'direction должен быть up или down (или передайте beforeId)' }, { status: 400 });
  }
  if (isDnd && body.beforeId !== null && typeof body.beforeId !== 'string') {
    return NextResponse.json({ error: 'beforeId должен быть id отчёта или null (в конец)' }, { status: 400 });
  }

  const db = systemDb();
  const existing = await db.query<{
    user_login: string;
    is_shared: boolean;
    shared_section: string | null;
    sort_order: number;
    deleted_at: Date | null;
  }>(
    `SELECT user_login, is_shared, shared_section, sort_order, deleted_at FROM saved_reports WHERE id = $1`,
    [id]
  );
  if (!existing.rows.length) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  const row = existing.rows[0];
  if (row.deleted_at !== null) {
    return NextResponse.json({ error: 'Отчёт в корзине — сначала восстановите' }, { status: 409 });
  }
  const isAdmin = isReportAdmin(session);
  if (row.user_login !== session.login && !(row.is_shared && isAdmin)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  // Скоуп — тот же раздел витрины, либо личный список этого же пользователя.
  const scopeSql = row.is_shared
    ? `is_shared = true AND shared_section = $1`
    : `NOT is_shared AND user_login = $1`;
  const scopeParam = row.is_shared ? row.shared_section : row.user_login;

  // ── Режим 2: drag-and-drop — полная перенумерация скоупа одним UPDATE ───────
  if (isDnd) {
    const beforeId = body.beforeId as string | null;
    if (beforeId === id) return NextResponse.json({ ok: true }); // дроп на самого себя — no-op

    const scopeRows = await db.query<{ id: string }>(
      `SELECT id FROM saved_reports
       WHERE deleted_at IS NULL AND ${scopeSql}
       ORDER BY sort_order ASC, created_at DESC`,
      [scopeParam]
    );
    const orderedIds = scopeRows.rows.map(r => r.id).filter(x => x !== id);
    let insertAt = orderedIds.length; // дефолт: в конец (beforeId === null)
    if (beforeId !== null) {
      insertAt = orderedIds.indexOf(beforeId);
      // beforeId не из этого скоупа/не существует/в корзине — кросс-скоуп дроп
      // невозможен из UI (списки раздельные), значит это рассинхрон клиента.
      if (insertAt === -1) {
        return NextResponse.json({ error: 'beforeId не найден в этом разделе — обновите страницу' }, { status: 409 });
      }
    }
    orderedIds.splice(insertAt, 0, id);

    // Один UPDATE на весь скоуп: unnest пар (id, позиция 1..N).
    await db.query(
      `UPDATE saved_reports sr
          SET sort_order = v.ord
         FROM (SELECT unnest($1::uuid[]) AS id,
                      generate_subscripts($1::uuid[], 1) AS ord) v
        WHERE sr.id = v.id`,
      [orderedIds]
    );
    return NextResponse.json({ ok: true });
  }

  // ── Режим 1: стрелки «вверх»/«вниз» — обмен с соседом (как раньше) ──────────
  const neighbor = await db.query<{ id: string; sort_order: number }>(
    body.direction === 'up'
      ? `SELECT id, sort_order FROM saved_reports
         WHERE deleted_at IS NULL AND ${scopeSql} AND sort_order < $2
         ORDER BY sort_order DESC LIMIT 1`
      : `SELECT id, sort_order FROM saved_reports
         WHERE deleted_at IS NULL AND ${scopeSql} AND sort_order > $2
         ORDER BY sort_order ASC LIMIT 1`,
    [scopeParam, row.sort_order]
  );
  if (!neighbor.rows.length) return NextResponse.json({ ok: true }); // уже на краю — no-op

  const other = neighbor.rows[0];
  await db.query(`UPDATE saved_reports SET sort_order = $1 WHERE id = $2`, [other.sort_order, id]);
  await db.query(`UPDATE saved_reports SET sort_order = $1 WHERE id = $2`, [row.sort_order, other.id]);

  return NextResponse.json({ ok: true });
}
