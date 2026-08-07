import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { systemDb } from '@/lib/db/clients';
import { fetchSkillTree, buySkillLevel } from '@/features/badges/engine/skills';
import { actorFromSession } from '@/lib/auth/pin';

// Дерево скиллов менеджера (задача 49): состояние веток + покупка уровня.
// Смотреть можно чужое (профили в ЛК публичные), покупать — только своё:
// уровень списывает MLT с кошелька, это денежная операция.

function bitrixIdOf(session: { bitrixUserId: string | null } | null): number | null {
  const n = Number(session?.bitrixUserId ?? NaN);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export async function GET(req: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const asked = Number(new URL(req.url).searchParams.get('bitrixId'));
  const self = bitrixIdOf(session);
  const mgr = Number.isFinite(asked) && asked > 0 ? asked : self;
  if (!mgr) return NextResponse.json({ error: 'Не определён сотрудник' }, { status: 400 });
  try {
    const tree = await fetchSkillTree(systemDb(), mgr);
    return NextResponse.json({ ...tree, bitrixId: mgr, isSelf: mgr === self });
  } catch (e) {
    // До миграций 159/166 таблиц нет — отдаём пустое дерево, а не 500:
    // профиль не должен падать целиком из-за невключённой механики.
    console.warn('[skills] GET:', e instanceof Error ? e.message : e);
    return NextResponse.json({ branches: [], balance: 0, multipliers: { xp: 1, mlt: 1, thresholds: 0 }, bitrixId: mgr, isSelf: mgr === self });
  }
}

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const self = bitrixIdOf(session);
  if (!self) return NextResponse.json({ error: 'Не определён сотрудник' }, { status: 400 });

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Некорректный JSON' }, { status: 400 }); }
  const branchKey = String(body.branchKey ?? '').trim();
  if (!branchKey) return NextResponse.json({ error: 'Не указана ветка' }, { status: 400 });
  // Купить можно только СЕБЕ: чужой bitrixId в теле игнорируем молча, а не
  // «проверяем права» — прав на трату чужого кошелька не бывает ни у кого.
  const res = await buySkillLevel(
    systemDb(), self, branchKey, session.login, actorFromSession(session, req), body.pin,
  );
  if (!res.ok) return NextResponse.json({ error: res.error, pinRequired: true }, { status: res.status ?? 400 });
  return NextResponse.json(res);
}
