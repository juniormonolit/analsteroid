import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { canViewManager } from '@/lib/org/managerAccess';
import { analyticsDb, systemDb } from '@/lib/db/clients';
import { tenureLabel } from '@/features/employees/engine/tenure';

// Данные табов ЛК (доп. Серёги 31.07 к 2655/2657): стаж из реестра сотрудников
// (COALESCE(manual_start_date, hire_date), как на странице «Сотрудники») и
// история начислений валюты (леджер: дата, награда, сумма — свежие сверху).
// Доступ: свои данные — любой залогиненный; чужие — тот же рубеж canViewManager,
// что у карточки менеджера (менеджер — себя, РОП — своих, руководство — всех).
export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const requested = req.nextUrl.searchParams.get('bitrixId');
  const bitrixId = requested && /^\d+$/.test(requested) ? requested : session.bitrixUserId;
  if (!bitrixId) return NextResponse.json({ tenure: null, ledger: [] });
  if (bitrixId !== session.bitrixUserId && !(await canViewManager(session, bitrixId))) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const id = Number(bitrixId);
  const [reg, ledger] = await Promise.all([
    analyticsDb().query<{ start_date: string | null }>(
      `SELECT to_char(coalesce(r.manual_start_date, e.hire_date), 'YYYY-MM-DD') AS start_date
         FROM sa.employees e
         LEFT JOIN sa.employee_registry r ON r.bitrix_id = e.bitrix_id
        WHERE e.bitrix_id = $1`,
      [id],
    ),
    systemDb().query<{ date: string; badge_name: string | null; icon: string | null; tier: string | null; amount: number }>(
      // Определение может быть удалено (кастомные) — тогда имя из снимка badge_key.
      `SELECT to_char(l.created_at AT TIME ZONE 'Europe/Moscow', 'YYYY-MM-DD') AS date,
              coalesce(d.name, l.badge_key, '—') AS badge_name, d.icon,
              a.tier, l.amount
         FROM badge_coin_ledger l
         LEFT JOIN badge_awards a ON a.id = l.badge_award_id
         LEFT JOIN badge_definitions d ON d.key = coalesce(a.badge_key, l.badge_key)
        WHERE l.bitrix_id = $1
        ORDER BY l.created_at DESC, l.id DESC
        LIMIT 300`,
      [id],
    ),
  ]);

  const startDate = reg.rows[0]?.start_date ?? null;
  return NextResponse.json({
    tenure: startDate ? { startDate, label: tenureLabel(startDate) } : null,
    ledger: ledger.rows,
  });
}
