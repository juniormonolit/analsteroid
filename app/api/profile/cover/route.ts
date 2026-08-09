import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { systemDb } from '@/lib/db/clients';
import { fetchXpProfile } from '@/features/xp/engine/xp';
import { COVERS, DEFAULT_COVER_ID, coverById, isCoverUnlocked, coverRequirementLabel } from '@/lib/profile/covers';
import { isGeneratedId } from '@/lib/profile/generated';
import { ownsGenerated } from '@/features/profile/engine/randomizer';

// Обложка СВОЕГО профиля (ЛК-соцсетка, этап 2). GET — каталог с признаком
// разблокировки (для пикера), POST — установка выбранной. Разблокировка
// считается СЕРВЕРОМ по уровням классов XP (fetchXpProfile) — UI-замочек в
// пикере это только отображение, реальный гейт здесь.

async function classLevels(bitrixId: number): Promise<Record<string, number>> {
  try {
    const xp = await fetchXpProfile(systemDb(), bitrixId);
    return Object.fromEntries(xp.classes.map(c => [c.name, c.level]));
  } catch {
    return {}; // XP недоступен → разблокированы только базовые
  }
}

export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!session.bitrixUserId) return NextResponse.json({ error: 'Аккаунт не связан с Битриксом' }, { status: 409 });
  const idNum = Number(session.bitrixUserId);

  const [levels, current] = await Promise.all([
    classLevels(idNum),
    systemDb().query<{ cover_id: string }>('SELECT cover_id FROM profile_covers WHERE bitrix_id = $1', [idNum])
      .then(r => r.rows[0]?.cover_id ?? null)
      .catch(() => null), // до миграции 149 — дефолт
  ]);

  return NextResponse.json({
    coverId: current ?? DEFAULT_COVER_ID,
    covers: COVERS.map(c => ({
      id: c.id,
      name: c.name,
      unlocked: isCoverUnlocked(c, levels),
      requirement: coverRequirementLabel(c),
    })),
  });
}

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!session.bitrixUserId) return NextResponse.json({ error: 'Аккаунт не связан с Битриксом' }, { status: 409 });
  const idNum = Number(session.bitrixUserId);

  const body = await req.json().catch(() => ({}));
  const coverId = String(body.coverId ?? '');
  // Обложка из рандомайзера (задача 63): в каталоге её нет, но она «своя»,
  // если этот сид человек прокрутил. Условия по классам к ней не применяются —
  // она куплена, а не заслужена, и в этом вся разница между двумя путями.
  if (isGeneratedId(coverId)) {
    if (!(await ownsGenerated(systemDb(), idNum, coverId))) {
      return NextResponse.json({ error: 'Этот вариант вам не выпадал' }, { status: 403 });
    }
    await systemDb().query(
      `INSERT INTO profile_covers (bitrix_id, cover_id, updated_at) VALUES ($1, $2, now())
       ON CONFLICT (bitrix_id) DO UPDATE SET cover_id = EXCLUDED.cover_id, updated_at = now()`,
      [idNum, coverId],
    );
    return NextResponse.json({ ok: true, coverId });
  }

  const def = COVERS.find(c => c.id === coverId);
  if (!def) return NextResponse.json({ error: 'Неизвестная обложка' }, { status: 400 });

  if (!isCoverUnlocked(def, await classLevels(idNum))) {
    const req_ = coverRequirementLabel(def);
    return NextResponse.json({ error: `Обложка ещё не открыта${req_ ? ` — нужен класс ${req_}` : ''}` }, { status: 403 });
  }

  await systemDb().query(
    `INSERT INTO profile_covers (bitrix_id, cover_id, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (bitrix_id) DO UPDATE SET cover_id = EXCLUDED.cover_id, updated_at = now()`,
    [idNum, def.id],
  );
  return NextResponse.json({ ok: true, coverId: coverById(def.id).id });
}
