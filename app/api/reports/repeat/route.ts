import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { permError } from '@/lib/auth/perms';
import { fetchRepeatReport } from '@/features/reports/engine/repeat';

// Раздел «Повторные» (#1725, возвращён задачей владельца 27.07). Доступ — ТОЛЬКО
// супер-админ (session.isSuperadmin), не section.sales — владелец явно сузил
// видимость раздела относительно первой версии. Дублирует проверку в
// app/(app)/sales/repeat/layout.tsx: скрытый пункт меню сам по себе не защита,
// прямой запрос к этому роуту должен получить 401/403 так же, как прямой заход
// на страницу.
// Данные — по всей истории клиентов (без периода), см. features/reports/engine/repeat.ts.
export async function GET() {
  const session = await getSession();
  // Задача Иосифа 10.09 (пункты «Ещё» — через матрицу прав): было ТОЛЬКО
  // супер-админ (#1725); теперь супер-админ (байпас внутри hasPerm) ИЛИ право
  // section.repeat, выданное роли в «Настройки → Матрица прав». Зеркально
  // гейту app/(app)/sales/repeat/layout.tsx.
  const err = permError(session, 'section.repeat');
  if (err) return err;

  try {
    const report = await fetchRepeatReport();
    return NextResponse.json(report);
  } catch (e) {
    console.error('[api/reports/repeat] failed:', e);
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}
