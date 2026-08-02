import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { superadminError } from '@/lib/auth/perms';
import { analyticsDb, systemDb } from '@/lib/db/clients';

// «Обратная связь» (задача 2765, правка владельца 02.08): очередь кликов по
// кнопкам «⚠️ Ошибка»/«👍 Полезно» под сообщениями «Аналитика». Бонус НЕ
// начисляется автоматически (защита от фарма) — админ вручную переводит
// строку в bonus_awarded/dismissed. Само начисление MLT — ручная операция
// админа СНАРУЖИ этого роута (существующий «Настройки → Геймификация →
// Штрафы»/ручное поощрение, app/api/badges/manual/route.ts) — этот роут
// только ведёт статус разбора очереди.

export async function GET() {
  const session = await getSession();
  const denied = superadminError(session);
  if (denied) return denied;

  const res = await systemDb().query<{
    id: string; log_id: string; bitrix_id: number; signal: 'error' | 'useful'; status: string;
    reviewed_by: string | null; reviewed_at: string | null; review_note: string | null; created_at: string;
  }>(`SELECT id, log_id, bitrix_id, signal, status, reviewed_by, reviewed_at, review_note, created_at
        FROM bot_feedback ORDER BY created_at DESC LIMIT 300`);

  const logIds = res.rows.map(r => Number(r.log_id));
  const logsRes = logIds.length > 0
    ? await systemDb().query<{ id: string; text: string; msg_type: string; decision_trace: unknown }>(
        `SELECT id, text, msg_type, decision_trace FROM bot_outbound_log WHERE id = ANY($1::bigint[])`, [logIds],
      )
    : { rows: [] as { id: string; text: string; msg_type: string; decision_trace: unknown }[] };
  const logById = new Map(logsRes.rows.map(r => [Number(r.id), r]));

  const bitrixIds = [...new Set(res.rows.map(r => r.bitrix_id))];
  const namesRes = bitrixIds.length > 0
    ? await analyticsDb().query<{ bitrix_id: number; full_name: string }>(
        `SELECT bitrix_id, full_name FROM sa.employees WHERE bitrix_id = ANY($1::int[])`, [bitrixIds],
      )
    : { rows: [] as { bitrix_id: number; full_name: string }[] };
  const nameById = new Map(namesRes.rows.map(r => [r.bitrix_id, r.full_name]));

  return NextResponse.json({
    rows: res.rows.map(r => {
      const log = logById.get(Number(r.log_id));
      return {
        id: Number(r.id),
        logId: Number(r.log_id),
        shortId: Number(r.log_id).toString(36).toUpperCase(),
        bitrixId: r.bitrix_id,
        managerName: nameById.get(r.bitrix_id) ?? null,
        signal: r.signal,
        status: r.status,
        reviewedBy: r.reviewed_by,
        reviewedAt: r.reviewed_at,
        reviewNote: r.review_note,
        createdAt: r.created_at,
        messageText: log?.text ?? null,
        msgType: log?.msg_type ?? null,
        decisionTrace: log?.decision_trace ?? null,
      };
    }),
  });
}

export async function PATCH(req: NextRequest) {
  const session = await getSession();
  const denied = superadminError(session);
  if (denied) return denied;

  const body = await req.json().catch(() => null) as { id?: number; status?: string; note?: string } | null;
  if (!body?.id || !body.status || !['bonus_awarded', 'dismissed', 'pending'].includes(body.status)) {
    return NextResponse.json({ error: 'Нужны id и status (bonus_awarded/dismissed/pending)' }, { status: 400 });
  }
  // Комментарий разбирающего ОБЯЗАТЕЛЕН при закрытии (bonus_awarded/dismissed) —
  // правка владельца 02.08: менеджер должен видеть человеческое объяснение, а
  // не молчание, иначе кнопку обратной связи перестанут нажимать.
  if ((body.status === 'bonus_awarded' || body.status === 'dismissed') && !body.note?.trim()) {
    return NextResponse.json({ error: 'Комментарий обязателен при закрытии сигнала — менеджер должен понимать, почему' }, { status: 400 });
  }
  await systemDb().query(
    `UPDATE bot_feedback SET status = $2, reviewed_by = $3, reviewed_at = now(), review_note = $4 WHERE id = $1`,
    [body.id, body.status, session!.displayName, body.note ?? null],
  );
  return NextResponse.json({ ok: true });
}
