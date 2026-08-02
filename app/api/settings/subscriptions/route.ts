import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { hasPerm } from '@/lib/auth/perms';
import { analyticsDb, systemDb } from '@/lib/db/clients';
import { DEFAULT_MANAGER_BOT_PREFS } from '@/lib/jobs/managerDigest';

// «Директор и выше видят все настройки подписки сотрудников — по роли, без
// возможности менять чужое» (правка владельца 02.08, задача 2765). Гейт —
// ТОЛЬКО action.subscriptions.view_all (не superadminError!) — по умолчанию
// эта выдача НЕ у РОПа: «не должен видеть, кто что отключил, и не должен
// иметь возможность включить обратно за них». Роль назначается вручную в
// «Настройки → Роли» ролям уровня «Директор»+.
//
// READ-ONLY: этот роут не имеет PATCH/POST — менять чужие настройки нельзя ни
// одной ролью, только сам менеджер через /api/me/bot-prefs.

export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!session.isSuperadmin && !hasPerm(session, 'action.subscriptions.view_all')) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const [managersRes, prefsRes] = await Promise.all([
    analyticsDb().query<{ bitrix_id: number; full_name: string }>(
      `SELECT bitrix_id, full_name FROM sa.employees WHERE bitrix_id IS NOT NULL AND is_active = true ORDER BY full_name`,
    ),
    systemDb().query<{
      bitrix_id: number; enabled: boolean; daily_digest: boolean; weekly_digest: boolean;
      advice_customers: boolean; advice_numbers: boolean; updated_at: string;
    }>('SELECT bitrix_id, enabled, daily_digest, weekly_digest, advice_customers, advice_numbers, updated_at FROM manager_bot_prefs')
      .catch(() => ({ rows: [] as never[] })),
  ]);
  const byId = new Map(prefsRes.rows.map(r => [r.bitrix_id, r]));

  const rows = managersRes.rows.map(m => {
    const p = byId.get(m.bitrix_id);
    return {
      bitrixId: m.bitrix_id,
      name: m.full_name,
      prefs: p ? {
        enabled: p.enabled, dailyDigest: p.daily_digest, weeklyDigest: p.weekly_digest,
        adviceCustomers: p.advice_customers, adviceNumbers: p.advice_numbers,
      } : DEFAULT_MANAGER_BOT_PREFS,
      customized: !!p,
      updatedAt: p?.updated_at ?? null,
    };
  });
  return NextResponse.json({ rows });
}
