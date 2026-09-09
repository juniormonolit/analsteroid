import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { loadSourceMap, loadManagerBranchMap } from '@/lib/marketing/sources';
import { canSeeManager, getSessionScope } from '@/lib/org/sessionScope';

// Полный справочник источников (892 строки) + карта менеджер→филиал для клиентской
// группировки сделок в маркетинговом дрилл-дауне. Кэшируется на сервере (10 мин).
export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const [map, mgrBranch, scope] = await Promise.all([loadSourceMap(), loadManagerBranchMap(), getSessionScope(session)]);
  // Аудит 09.09: справочник источников — общий, а карта «менеджер → филиал» —
  // это список всех менеджеров компании; отдаём только менеджеров среза сессии
  // (админ — всех).
  const managerBranches = Object.fromEntries([...mgrBranch].filter(([id]) => canSeeManager(scope, id)));
  return NextResponse.json({
    sources: [...map.values()],
    managerBranches,
  });
}
