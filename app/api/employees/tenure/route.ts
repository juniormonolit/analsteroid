import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { hasPerm, permError } from '@/lib/auth/perms';
import { canSeeManager, getSessionScope, scopeForbidden } from '@/lib/org/sessionScope';
import {
  createTenure, deleteTenure, getHrCard, getTenure, listTenures, listUnlinkedHrCards, updateTenure, validateTenure,
  type TenureInput,
} from '@/lib/org/tenures';

// Карточка сотрудника на логине (таймлайн «Сотрудники»): периоды «кто на логине с–по»,
// правка дат найма/увольнения, ФИО, должности; привязка уволенных из карточек 1054.
// Читать — как список (срез сессии); писать — админ или section.employees_edit.

const FORBIDDEN_EDIT = 'Редактировать сотрудников может администратор или тот, кому выдано право «Сотрудники: редактирование»';

export async function GET(req: Request) {
  const session = await getSession();
  const canEdit = hasPerm(session, 'section.employees_edit');
  const err = canEdit ? null : permError(session, 'section.employees');
  if (err) return err;
  const bitrixId = Number(new URL(req.url).searchParams.get('bitrixId'));
  if (!Number.isInteger(bitrixId) || bitrixId <= 0) return NextResponse.json({ error: 'bitrixId обязателен' }, { status: 400 });
  if (!canEdit && !canSeeManager(await getSessionScope(session!), String(bitrixId))) {
    return scopeForbidden('Этот сотрудник вне вашего среза');
  }
  const [tenures, hrCards] = await Promise.all([
    listTenures(bitrixId),
    canEdit ? listUnlinkedHrCards() : Promise.resolve([]),
  ]);
  return NextResponse.json({ tenures, hrCards, canEdit });
}

function parseDate(v: unknown): string | null | undefined {
  if (v === null || v === '') return null;
  if (typeof v === 'string') return v;
  return undefined; // невалидный тип
}

export async function POST(req: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!hasPerm(session, 'section.employees_edit')) return NextResponse.json({ error: FORBIDDEN_EDIT }, { status: 403 });

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Некорректный JSON' }, { status: 400 }); }
  const op = body.op;

  if (op === 'delete') {
    const t = await getTenure(Number(body.id));
    if (!t) return NextResponse.json({ error: 'Период не найден' }, { status: 404 });
    await deleteTenure(t.id);
    return NextResponse.json({ ok: true });
  }

  if (op !== 'create' && op !== 'update') return NextResponse.json({ error: 'op: create | update | delete' }, { status: 400 });

  let bitrixId: number;
  let editingId: number | null = null;
  if (op === 'update') {
    const t = await getTenure(Number(body.id));
    if (!t) return NextResponse.json({ error: 'Период не найден' }, { status: 404 });
    bitrixId = t.bitrixId; editingId = t.id;
  } else {
    bitrixId = Number(body.bitrixId);
    if (!Number.isInteger(bitrixId) || bitrixId <= 0) return NextResponse.json({ error: 'bitrixId обязателен' }, { status: 400 });
  }

  // Привязка карточки 1054: ФИО/даты/должность по умолчанию берём из неё.
  let hrItemId: number | null = null;
  let hrDefaults: Partial<TenureInput> = {};
  if (op === 'create' && body.hrItemId != null) {
    const card = await getHrCard(Number(body.hrItemId));
    if (!card) return NextResponse.json({ error: 'Карточка Битрикса не найдена — запустите синхронизацию оргструктуры' }, { status: 404 });
    hrItemId = card.itemId;
    hrDefaults = {
      personName: card.title, startDate: card.hiredDate ?? card.cardCreated,
      endDate: card.isEmployed ? null : card.firedDate, position: card.position,
    };
  }

  const startDate = 'startDate' in body ? parseDate(body.startDate) : (hrDefaults.startDate ?? null);
  const endDate = 'endDate' in body ? parseDate(body.endDate) : (hrDefaults.endDate ?? null);
  if (startDate === undefined || endDate === undefined) return NextResponse.json({ error: 'Даты — строка ГГГГ-ММ-ДД или пусто' }, { status: 400 });
  const input: TenureInput = {
    personName: typeof body.personName === 'string' ? body.personName : (hrDefaults.personName ?? ''),
    startDate, endDate,
    position: typeof body.position === 'string' ? body.position.slice(0, 200) : (hrDefaults.position ?? null),
  };

  const others = (await listTenures(bitrixId)).filter(t => t.id !== editingId);
  const invalid = validateTenure(input, others);
  if (invalid) return NextResponse.json({ error: invalid }, { status: 400 });

  try {
    if (op === 'update') await updateTenure(editingId!, input, session.login);
    else await createTenure(bitrixId, { ...input, hrItemId }, session.login);
  } catch (e) {
    if ((e as { code?: string }).code === '23505') {
      return NextResponse.json({ error: 'Эта карточка Битрикса уже привязана, или на логине уже есть человек без даты увольнения' }, { status: 409 });
    }
    throw e;
  }
  return NextResponse.json({ ok: true });
}
