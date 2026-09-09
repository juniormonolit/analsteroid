import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { superadminError } from '@/lib/auth/perms';
import { channelEnabled } from '@/lib/bitrix/notify';
import { loadScenario, runScenario } from '@/lib/jobs/scenarios';

// «Запустить сейчас» — реальный прогон с отправкой и записью состояния, не
// дожидаясь часа проверки. Рубильники не обходит: функция «Сценарии коучинга»
// выключена или бот вырублен — понятная ошибка. Глобальный тест-режим
// (dry_run_managers) уважается внутри sendManagerBotMessage: сообщения лягут в
// журнал как «не отправлено», а цепочки при этом продвинутся — как у дайджестов.
// Необязательно body.managerIds — прогнать только по выбранным менеджерам.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  const err = superadminError(session);
  if (err) return err;
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/.test(id)) return NextResponse.json({ error: 'Не указан сценарий' }, { status: 400 });
  const s = await loadScenario(id);
  if (!s) return NextResponse.json({ error: 'Сценарий не найден' }, { status: 404 });
  if (!(await channelEnabled('scenarios'))) {
    return NextResponse.json({ error: 'Функция «Сценарии коучинга» выключена (или бот вырублен) — включите во вкладке «Функции»' }, { status: 409 });
  }
  const body = await req.json().catch(() => ({})) as { managerIds?: unknown };
  const managerIds = Array.isArray(body.managerIds)
    ? body.managerIds.map(Number).filter(n => Number.isInteger(n) && n > 0)
    : undefined;
  try {
    const res = await runScenario(s, { managerIds });
    return NextResponse.json({ summary: res.summary });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Прогон не удался' }, { status: 400 });
  }
}
