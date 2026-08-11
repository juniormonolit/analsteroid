import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { superadminError } from '@/lib/auth/perms';
import { systemDb, analyticsDb } from '@/lib/db/clients';

// Журнал подсказок «кому звонить» — сами строки, а не только счётчики
// (владелец 11.08: «хочу видеть реальный журнал. А тут только цифры»).
//
// Имя менеджера живёт в ДРУГОЙ базе (sa.org_resolved_hierarchy в analytics),
// поэтому join невозможен — тянем отдельным запросом и мёржим в JS, как в
// остальных кросс-БД местах проекта.

const STATUSES = ['active', 'contacted', 'success', 'closed_no_contact', 'closed_no_deal'] as const;
const PAGE = 50;

export async function GET(req: NextRequest) {
  const session = await getSession();
  const err = superadminError(session);
  if (err) return err;

  const sp = req.nextUrl.searchParams;
  const status = sp.get('status');
  const search = (sp.get('q') ?? '').trim();
  const page = Math.max(0, Number(sp.get('page') ?? 0) || 0);

  const where: string[] = ['test_run = false'];
  const params: unknown[] = [];
  if (status && (STATUSES as readonly string[]).includes(status)) {
    params.push(status); where.push(`status = $${params.length}`);
  }
  if (search) {
    params.push(`%${search}%`);
    where.push(`(client_name ILIKE $${params.length} OR recommended_group ILIKE $${params.length} OR client_key ILIKE $${params.length})`);
  }
  const whereSql = where.join(' AND ');

  const db = systemDb();
  try {
    const [rowsRes, cntRes] = await Promise.all([
      db.query<Record<string, unknown>>(
        `SELECT id, manager_bitrix_id, client_key, client_name, recommended_group, based_on_groups,
                fallback, confidence_pct, call_signal, digest_kind, status, reminder_count,
                advised_at, contacted_at, resolved_at, resolved_reason
           FROM advice_log WHERE ${whereSql}
          ORDER BY advised_at DESC LIMIT ${PAGE} OFFSET ${page * PAGE}`,
        params,
      ),
      db.query<{ n: string }>(`SELECT count(*)::text AS n FROM advice_log WHERE ${whereSql}`, params),
    ]);

    const mgrIds = [...new Set(rowsRes.rows.map(r => String(r.manager_bitrix_id)))];
    const names = new Map<string, string>();
    if (mgrIds.length > 0) {
      const nr = await analyticsDb().query<{ id: string; name: string }>(
        `SELECT DISTINCT manager_bitrix_user_id::text AS id, manager_name AS name
           FROM sa.org_resolved_hierarchy WHERE manager_bitrix_user_id::text = ANY($1::text[])`,
        [mgrIds],
      ).catch(() => ({ rows: [] as { id: string; name: string }[] }));
      for (const x of nr.rows) if (x.name) names.set(x.id, x.name);
    }

    const iso = (v: unknown) => (v ? new Date(v as string).toISOString() : null);
    return NextResponse.json({
      total: Number(cntRes.rows[0]?.n ?? 0),
      page, pageSize: PAGE,
      rows: rowsRes.rows.map(r => ({
        id: Number(r.id),
        managerId: String(r.manager_bitrix_id),
        managerName: names.get(String(r.manager_bitrix_id)) ?? null,
        clientKey: String(r.client_key),
        clientName: (r.client_name as string) ?? null,
        recommendedGroup: String(r.recommended_group),
        basedOnGroups: (r.based_on_groups as string[]) ?? [],
        fallback: Boolean(r.fallback),
        confidencePct: r.confidence_pct !== null ? Number(r.confidence_pct) : null,
        callSignal: (r.call_signal as string) ?? null,
        digestKind: String(r.digest_kind),
        status: String(r.status),
        reminderCount: Number(r.reminder_count ?? 0),
        advisedAt: iso(r.advised_at),
        contactedAt: iso(r.contacted_at),
        resolvedAt: iso(r.resolved_at),
        resolvedReason: (r.resolved_reason as string) ?? null,
      })),
    });
  } catch (e) {
    console.warn('[digest-log] GET:', e instanceof Error ? e.message : e);
    return NextResponse.json({ total: 0, page: 0, pageSize: PAGE, rows: [], error: 'Журнал недоступен' });
  }
}
