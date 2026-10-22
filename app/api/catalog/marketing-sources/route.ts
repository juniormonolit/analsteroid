import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { loadSourceMap, loadManagerBranchMap } from '@/lib/marketing/sources';
import { loadGroupings } from '@/lib/marketing/groupings';
import { canSeeManager, getSessionScope } from '@/lib/org/sessionScope';

// Полный справочник источников (892 строки) + карта менеджер→филиал для клиентской
// группировки сделок в маркетинговом дрилл-дауне. Кэшируется на сервере (10 мин).
export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const [map, mgrBranch, scope, groupings] = await Promise.all([loadSourceMap(), loadManagerBranchMap(), getSessionScope(session),
    // Структура «Ещё → Источники» — необязательная часть: её сбой не должен ронять дрилл
    // старых маркетинговых отчётов (выкат 22.10: 500 из-за прав на новые таблицы).
    loadGroupings().catch((e) => { console.error('[marketing-sources] groupings', e); return new Map() as Awaited<ReturnType<typeof loadGroupings>>; })]);
  // Аудит 09.09: справочник источников — общий, а карта «менеджер → филиал» —
  // это список всех менеджеров компании; отдаём только менеджеров среза сессии
  // (админ — всех).
  const managerBranches = Object.fromEntries([...mgrBranch].filter(([id]) => canSeeManager(scope, id)));
  return NextResponse.json({
    sources: [...map.values()],
    managerBranches,
    // Группировки «Ещё → Источники» (миграция 240): измерения `g:<id>` для селекторов
    // отчёта и раскладки сделок дрилл-дауна на клиенте (source_id → название группы).
    groupings: [...groupings.values()].map(g => {
      const names = new Map(g.groups.map(x => [x.id, x.name]));
      return {
        key: `g:${g.id}`,
        label: g.name,
        builtinKey: g.builtinKey,
        assign: Object.fromEntries([...g.assign].flatMap(([sid, gid]) => names.has(gid) ? [[sid, names.get(gid)!]] : [])),
      };
    }),
  });
}
