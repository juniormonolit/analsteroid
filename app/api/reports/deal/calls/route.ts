import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { analyticsDb } from '@/lib/db/clients';
import { loadManagerInfoMap } from '@/lib/marketing/sources';
import { getSessionScope, canSeeManager, scopeForbidden } from '@/lib/org/sessionScope';

// История звонков сделки (таб «Звонки» карточки сделки, задача КОЛСТАТ, п. B, 10.07).
// Отдельный лёгкий эндпоинт (не расширяем основной /api/reports/deal) — карточка
// запрашивает его ЛЕНИВО, только при открытии таба «Звонки», чтобы не бить
// va.calls на каждое открытие карточки (продукты/хронология уже приходят с
// основным запросом, звонки — отдельный источник данных).
export interface DealCallRow {
  id: string;
  calledAt: string;
  direction: 'inbound' | 'outbound';
  result: 'completed' | 'missed' | 'voicemail' | 'operator_error';
  durationSeconds: number | null;
  managerId: string | null;
  managerName: string | null;
  hasRecording: boolean;
}

export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const id = req.nextUrl.searchParams.get('id');
  if (!id || !/^\d+$/.test(id)) {
    return NextResponse.json({ error: 'id (число) обязателен' }, { status: 400 });
  }

  // Аудит 09.09 (IDOR): звонки отдавались по любому deal_id. Сначала владелец
  // сделки — он должен входить в срез сессии (lib/org/sessionScope.ts), иначе 403.
  const owner = await analyticsDb().query<{ manager_id: string | null }>(
    'SELECT current_manager_id::text AS manager_id FROM deals WHERE deal_id = $1',
    [Number(id)],
  );
  if (!owner.rows.length) return NextResponse.json({ error: 'Сделка не найдена' }, { status: 404 });
  const scope = await getSessionScope(session);
  if (!canSeeManager(scope, owner.rows[0].manager_id)) return scopeForbidden('Эта сделка вам недоступна');

  const res = await analyticsDb().query<{
    id: string; called_at: string; direction: 'inbound' | 'outbound';
    result: 'completed' | 'missed' | 'voicemail' | 'operator_error';
    duration_seconds: number | null; manager_id: string | null; recording_file_id: string | null;
  }>(
    `SELECT id::text, called_at, direction, result, duration_seconds,
            manager_id::text AS manager_id, recording_file_id
       FROM va.calls
      WHERE deal_id = $1
      ORDER BY called_at DESC`,
    [Number(id)],
  );

  const mgrInfo = await loadManagerInfoMap();

  const calls: DealCallRow[] = res.rows.map(r => ({
    id: r.id,
    calledAt: r.called_at,
    direction: r.direction,
    result: r.result,
    durationSeconds: r.duration_seconds,
    managerId: r.manager_id,
    managerName: r.manager_id ? (mgrInfo.get(r.manager_id)?.name ?? `#${r.manager_id}`) : null,
    // Иконка записи — только для completed с заполненным recording_file_id. Прямой
    // ссылки на файл нет (нужна интеграция с телефонией — итерация 2, см. задачу),
    // поэтому иконка БЕЗ ссылки, чисто индикатор наличия записи.
    hasRecording: r.result === 'completed' && !!r.recording_file_id,
  }));

  return NextResponse.json({ calls });
}
