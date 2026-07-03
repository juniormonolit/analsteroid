import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { loadSourceMap, loadManagerBranchMap } from '@/lib/marketing/sources';

// Полный справочник источников (892 строки) + карта менеджер→филиал для клиентской
// группировки сделок в маркетинговом дрилл-дауне. Кэшируется на сервере (10 мин).
export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const [map, mgrBranch] = await Promise.all([loadSourceMap(), loadManagerBranchMap()]);
  return NextResponse.json({
    sources: [...map.values()],
    managerBranches: Object.fromEntries(mgrBranch),
  });
}
