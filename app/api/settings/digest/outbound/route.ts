import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { superadminError } from '@/lib/auth/perms';
import { analyticsDb, systemDb } from '@/lib/db/clients';

// «Исходящие» (задача 2765, правка владельца 02.08): лог всех сообщений
// «Аналитика» менеджерам (bot_outbound_log) — с ID (base36 от id), полным
// текстом и следом решения (decision_trace). Поиск по ID — owner дословно
// «в таб «Исходящие» добавь поиск по ID — открывается карточка сообщения с
// полным следом решения».

export async function GET(req: NextRequest) {
  const session = await getSession();
  const denied = superadminError(session);
  if (denied) return denied;

  const { searchParams } = new URL(req.url);
  const idQuery = searchParams.get('id'); // base36 ID (напр. "K3F") или чистое число (log_id)
  const limit = Math.min(Number(searchParams.get('limit') ?? 200) || 200, 500);

  let rows;
  if (idQuery) {
    const asInt = /^[0-9a-zA-Z]+$/.test(idQuery) ? parseInt(idQuery, 36) : NaN;
    rows = await systemDb().query(
      `SELECT id, bitrix_id, msg_type, text, trigger_reason, dry_run, sent, suppress_reason, decision_trace, created_at
         FROM bot_outbound_log WHERE id = $1`,
      [Number.isFinite(asInt) ? asInt : -1],
    );
  } else {
    rows = await systemDb().query(
      `SELECT id, bitrix_id, msg_type, text, trigger_reason, dry_run, sent, suppress_reason, decision_trace, created_at
         FROM bot_outbound_log ORDER BY created_at DESC LIMIT $1`,
      [limit],
    );
  }

  const bitrixIds = [...new Set(rows.rows.map((r: { bitrix_id: number }) => r.bitrix_id))];
  const namesRes = bitrixIds.length > 0
    ? await analyticsDb().query<{ bitrix_id: number; full_name: string }>(
        `SELECT bitrix_id, full_name FROM sa.employees WHERE bitrix_id = ANY($1::int[])`, [bitrixIds],
      )
    : { rows: [] as { bitrix_id: number; full_name: string }[] };
  const nameById = new Map(namesRes.rows.map(r => [r.bitrix_id, r.full_name]));

  return NextResponse.json({
    rows: rows.rows.map((r: {
      id: string; bitrix_id: number; msg_type: string; text: string; trigger_reason: string | null;
      dry_run: boolean; sent: boolean; suppress_reason: string | null; decision_trace: unknown; created_at: string;
    }) => ({
      logId: Number(r.id),
      shortId: Number(r.id).toString(36).toUpperCase(),
      bitrixId: r.bitrix_id,
      managerName: nameById.get(r.bitrix_id) ?? null,
      msgType: r.msg_type,
      text: r.text,
      triggerReason: r.trigger_reason,
      dryRun: r.dry_run,
      sent: r.sent,
      suppressReason: r.suppress_reason,
      decisionTrace: r.decision_trace,
      createdAt: r.created_at,
    })),
  });
}
