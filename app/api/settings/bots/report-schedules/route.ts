import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { superadminError } from '@/lib/auth/perms';
import { systemDb } from '@/lib/db/clients';

// Расписания авторассылки сохранённых отчётов «Мой отчёт» (задача владельца 09.09).
// Только супер-админ — как и весь реестр функций бота. Новое расписание создаётся
// ВЫКЛЮЧЕННЫМ (решение владельца: «что надо — включу сам руками»).

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

function parseWeekdays(raw: unknown): number[] | null {
  if (!Array.isArray(raw)) return null;
  const days = [...new Set(raw.map(Number).filter(n => Number.isInteger(n) && n >= 1 && n <= 7))].sort();
  return days.length ? days : null;
}

export async function GET() {
  const session = await getSession();
  const err = superadminError(session);
  if (err) return err;
  const r = await systemDb().query<{
    id: string; template_id: string; template_name: string | null; owner_login: string; owner_name: string | null;
    recipient_bitrix_id: string; recipient_name: string | null; send_time: string; weekdays: number[];
    enabled: boolean; last_sent_at: string | null; last_error: string | null; created_by: string | null;
  }>(
    `SELECT s.id::text, s.template_id::text, t.name AS template_name, s.owner_login, ou.display_name AS owner_name,
            s.recipient_bitrix_id, ru.display_name AS recipient_name,
            to_char(s.send_time, 'HH24:MI') AS send_time, s.weekdays, s.enabled,
            s.last_sent_at, s.last_error, s.created_by
       FROM report_schedules s
       LEFT JOIN report_templates t ON t.id = s.template_id
       LEFT JOIN users ou ON ou.login = s.owner_login
       LEFT JOIN users ru ON ru.bitrix_user_id = s.recipient_bitrix_id
      ORDER BY s.send_time, t.name`,
  );
  return NextResponse.json({
    schedules: r.rows.map(x => ({
      id: x.id, templateId: x.template_id, templateName: x.template_name,
      ownerLogin: x.owner_login, ownerName: x.owner_name,
      recipientBitrixId: x.recipient_bitrix_id, recipientName: x.recipient_name,
      sendTime: x.send_time, weekdays: x.weekdays, enabled: x.enabled,
      lastSentAt: x.last_sent_at ? new Date(x.last_sent_at).toISOString() : null,
      lastError: x.last_error, createdBy: x.created_by,
    })),
  });
}

export async function POST(req: NextRequest) {
  const session = await getSession();
  const err = superadminError(session);
  if (err) return err;
  const body = await req.json().catch(() => null) as Record<string, unknown> | null;
  if (!body) return NextResponse.json({ error: 'Некорректный JSON' }, { status: 400 });

  const templateId = String(body.templateId ?? '');
  const recipient = String(body.recipientBitrixId ?? '').trim();
  const sendTime = String(body.sendTime ?? '18:00');
  const weekdays = parseWeekdays(body.weekdays ?? [1, 2, 3, 4, 5]);
  if (!/^[0-9a-f-]{36}$/.test(templateId)) return NextResponse.json({ error: 'Выберите отчёт' }, { status: 400 });
  if (!/^\d+$/.test(recipient)) return NextResponse.json({ error: 'Выберите получателя (нужна привязка к Битриксу)' }, { status: 400 });
  if (!TIME_RE.test(sendTime)) return NextResponse.json({ error: 'Время в формате ЧЧ:ММ' }, { status: 400 });
  if (!weekdays) return NextResponse.json({ error: 'Отметьте хотя бы один день недели' }, { status: 400 });

  const db = systemDb();
  const t = await db.query<{ user_login: string }>(`SELECT user_login FROM report_templates WHERE id = $1`, [templateId]);
  if (!t.rows.length) return NextResponse.json({ error: 'Шаблон отчёта не найден' }, { status: 404 });

  const ins = await db.query<{ id: string }>(
    `INSERT INTO report_schedules (template_id, owner_login, recipient_bitrix_id, send_time, weekdays, enabled, created_by)
     VALUES ($1, $2, $3, $4::time, $5, false, $6) RETURNING id::text`,
    [templateId, t.rows[0].user_login, recipient, sendTime, weekdays, session!.login],
  );
  return NextResponse.json({ ok: true, id: ins.rows[0].id });
}

export async function PATCH(req: NextRequest) {
  const session = await getSession();
  const err = superadminError(session);
  if (err) return err;
  const body = await req.json().catch(() => null) as Record<string, unknown> | null;
  if (!body || !/^[0-9a-f-]{36}$/.test(String(body.id ?? ''))) return NextResponse.json({ error: 'Не указано расписание' }, { status: 400 });

  const sets: string[] = ['updated_at = now()'];
  const params: unknown[] = [String(body.id)];
  if ('enabled' in body) { params.push(Boolean(body.enabled)); sets.push(`enabled = $${params.length}`); }
  if ('sendTime' in body) {
    const v = String(body.sendTime); if (!TIME_RE.test(v)) return NextResponse.json({ error: 'Время в формате ЧЧ:ММ' }, { status: 400 });
    params.push(v); sets.push(`send_time = $${params.length}::time`);
  }
  if ('weekdays' in body) {
    const w = parseWeekdays(body.weekdays); if (!w) return NextResponse.json({ error: 'Отметьте хотя бы один день недели' }, { status: 400 });
    params.push(w); sets.push(`weekdays = $${params.length}`);
  }
  if ('recipientBitrixId' in body) {
    const v = String(body.recipientBitrixId).trim(); if (!/^\d+$/.test(v)) return NextResponse.json({ error: 'Некорректный получатель' }, { status: 400 });
    params.push(v); sets.push(`recipient_bitrix_id = $${params.length}`);
  }
  if (sets.length === 1) return NextResponse.json({ error: 'Нечего менять' }, { status: 400 });
  const r = await systemDb().query(`UPDATE report_schedules SET ${sets.join(', ')} WHERE id = $1`, params);
  if (r.rowCount === 0) return NextResponse.json({ error: 'Расписание не найдено' }, { status: 404 });
  return NextResponse.json({ ok: true });
}

export async function DELETE(req: NextRequest) {
  const session = await getSession();
  const err = superadminError(session);
  if (err) return err;
  const id = req.nextUrl.searchParams.get('id') ?? '';
  if (!/^[0-9a-f-]{36}$/.test(id)) return NextResponse.json({ error: 'Не указано расписание' }, { status: 400 });
  await systemDb().query(`DELETE FROM report_schedules WHERE id = $1`, [id]);
  return NextResponse.json({ ok: true });
}
