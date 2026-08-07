import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { analyticsDb } from '@/lib/db/clients';
import { dealFilterOptions, DEAL_FILTER_FIELDS, opsForField } from '@/lib/metrics/dealFilters';

// Справочники значений для «Фильтра сделок» (задача владельца 07.08): воронки,
// стадии, товарные группы, источники. Отдаём одним запросом — пикер открывается
// редко, но сразу со всеми полями, и клиенту не нужно знать, где что лежит.
//
// Гейта по правам нет намеренно: это те же справочники, что человек и так видит
// в самом отчёте (названия воронок/стадий/товарных групп), никаких данных о
// сделках или деньгах здесь нет. Сессия при этом обязательна.
export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const client = await analyticsDb().connect();
  try {
    const options = await dealFilterOptions(client);
    // Каталог полей отдаём отсюда же — UI не дублирует список полей и операторов,
    // источник правды один (lib/metrics/dealFilters.ts).
    const fields = Object.entries(DEAL_FILTER_FIELDS).map(([key, def]) => ({
      key,
      label: def.label,
      kind: def.customSql ? 'enum' : def.kind,
      options: def.options ?? (def.customSql ? 'client_kind' : null),
      ops: opsForField(key),
    }));
    return NextResponse.json({
      fields,
      options: { ...options, client_kind: [{ value: 'b2b', label: 'ЮЛ (юрлица)' }, { value: 'b2c', label: 'ФЛ (частные лица)' }] },
    });
  } finally {
    client.release();
  }
}
