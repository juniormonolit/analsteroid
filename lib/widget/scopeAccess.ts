import type { SessionUser } from '@/lib/auth/session';
import { getSessionScope, scopeForbidden, type SessionScope } from '@/lib/org/sessionScope';
import { loadScopeCoverage } from '@/lib/org/scopeCoverage';
import type { WidgetConfig } from './config';
import type { WidgetCatalog } from './resolve';

// Аудит 09.09: конфиг виджета мог указывать ЛЮБОЙ филиал/отдел из блоба
// widget:metrics (каталог перечислял их все), и /custom по персональному токену
// отдавал их метрики без сверки с правами владельца. Правило владельца: «Россия» —
// только Администратор/супер-админ; филиал — если срез покрывает его целиком
// (Директор); отдел — если он в срезе. Ключи блоба: departments — uuid отдела
// (org_resolved_hierarchy.department_id), branches — метка (СПБ/МСК/КРД/…) —
// те же, что режет loadScopeCoverage.

export interface WidgetScopeAccess {
  scope: SessionScope;
  allows(config: Pick<WidgetConfig, 'scope_kind' | 'scope_id'>): boolean;
  filterCatalog(catalog: WidgetCatalog): WidgetCatalog;
}

export async function loadWidgetScopeAccess(user: SessionUser): Promise<WidgetScopeAccess> {
  const scope = await getSessionScope(user);
  const coverage = await loadScopeCoverage(scope);
  const allows = (config: Pick<WidgetConfig, 'scope_kind' | 'scope_id'>): boolean => {
    if (scope.kind === 'all') return true;
    if (config.scope_kind === 'russia') return false;
    if (!config.scope_id) return false;
    if (config.scope_kind === 'branch') return !!coverage?.branches.has(config.scope_id);
    return scope.kind === 'depts' && scope.deptIds.has(config.scope_id);
  };
  return {
    scope,
    allows,
    filterCatalog(catalog) {
      if (scope.kind === 'all') return catalog;
      return {
        ...catalog,
        branches: catalog.branches.filter(b => allows({ scope_kind: 'branch', scope_id: b.id })),
        departments: catalog.departments.filter(d => allows({ scope_kind: 'department', scope_id: d.id })),
      };
    },
  };
}

/** 403, если разрез конфига вне среза пользователя; иначе null. */
export async function widgetScopeError(user: SessionUser, config: Pick<WidgetConfig, 'scope_kind' | 'scope_id'>): Promise<Response | null> {
  const access = await loadWidgetScopeAccess(user);
  return access.allows(config) ? null : scopeForbidden('Этот разрез вам недоступен');
}

/** Для /custom (без cookie): токен уже превращён в user_id, нужен SessionUser
 *  с ролью — тот же SELECT, что у getSession (lib/auth/session.ts::loadSessionUserByLogin). */
export function widgetConfigForbidden(): Response {
  return scopeForbidden('Разрез виджета вне ваших отделов — пересоберите виджет');
}
