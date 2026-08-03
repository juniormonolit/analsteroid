import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { canViewManager } from '@/lib/org/managerAccess';
import { analyticsDb, systemDb } from '@/lib/db/clients';
import { tenureLabel } from '@/features/employees/engine/tenure';
import { getExpiringSoon } from '@/features/badges/engine/wallet';
import { fetchXpProfile } from '@/features/xp/engine/xp';

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
    // Задача 2820: раньше водило sa.employees (мёртвая заготовка) — если id туда
    // не попал (52% активных на проверке 03.08), запрос отдавал 0 строк и вкладка
    // «Профиль» молча теряла стаж. hire_date у sa.employees на проде и так всегда
    // пуст (см. features/employees/ui/EmployeesPage.tsx) — единственный реальный
    // источник даты начала — sa.employee_registry, читаем её напрямую.
    analyticsDb().query<{ start_date: string | null }>(
      `SELECT to_char(manual_start_date, 'YYYY-MM-DD') AS start_date
         FROM sa.employee_registry WHERE bitrix_id = $1`,
      [id],
    ),
    // Единая «банковская выписка» (доп. Серёги 31.07): авто-начисления движка +
    // ручные поощрения/штрафы (+ сторно-записи) — дата, награда/причина, кем,
    // за что, сумма со знаком. Определение может быть удалено (кастомные) —
    // тогда имя из снимка badge_key.
    systemDb().query<{
      id: number; date: string; badge_name: string | null; icon: string | null;
      tier: string | null; amount: number; source: string; actor_login: string | null;
      comment: string | null; penalty_name: string | null; reversal_of: number | null;
      reversed: boolean;
    }>(
      `SELECT l.id::int AS id, to_char(l.created_at AT TIME ZONE 'Europe/Moscow', 'YYYY-MM-DD') AS date,
              coalesce(d.name, l.badge_key) AS badge_name, d.icon,
              a.tier, l.amount, l.source, l.actor_login, l.comment,
              l.currency, pt.name AS penalty_name, l.reversal_of::int AS reversal_of,
              EXISTS (SELECT 1 FROM badge_coin_ledger rr WHERE rr.reversal_of = l.id) AS reversed
         FROM badge_coin_ledger l
         LEFT JOIN badge_awards a ON a.id = l.badge_award_id
         LEFT JOIN badge_definitions d ON d.key = coalesce(a.badge_key, l.badge_key)
         LEFT JOIN penalty_types pt ON pt.id = l.penalty_type_id
        WHERE l.bitrix_id = $1
        ORDER BY l.created_at DESC, l.id DESC
        LIMIT 300`,
      [id],
    ),
  ]);

  // Рублёвый кошелёк (миграция 116) + курс конвертации — для профиля/выписки.
  // expiring — плашка TTL (31.07): «сгорит N ебаллов через X дней», горизонт 30 дней.
  const [rub, rate, expiring, xp] = await Promise.all([
    systemDb().query<{ balance: string }>(`SELECT balance FROM badge_rub_balances WHERE bitrix_id = $1`, [id]),
    systemDb().query<{ rate: string }>(`SELECT rub_to_eball_rate AS rate FROM badge_coin_settings WHERE id = 1`),
    getExpiringSoon(systemDb(), id),
    // XP-профиль (миграция 124): уровень/титул/классы — таб «Профиль».
    fetchXpProfile(systemDb(), id).catch(() => null),
  ]);

  const startDate = reg.rows[0]?.start_date ?? null;
  return NextResponse.json({
    tenure: startDate ? { startDate, label: tenureLabel(startDate) } : null,
    ledger: ledger.rows,
    rubBalance: Number(rub.rows[0]?.balance ?? 0),
    rubToEballRate: Number(rate.rows[0]?.rate ?? 1),
    expiring,
    xp,
  });
}
