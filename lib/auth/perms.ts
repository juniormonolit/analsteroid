import type { SessionUser } from './session';

// Каталог прав. БД (roles.permissions) хранит только выбранные ключи —
// неизвестные ключи игнорируются, так что добавление нового ключа не требует миграции.

export const PERM_SECTIONS = [
  { key: 'section.sales', label: 'Продажи' },
  { key: 'section.marketing', label: 'Маркетинг' },
  { key: 'section.summary', label: 'Сводная' },
  { key: 'section.plans', label: 'Планы' },
  { key: 'section.decomposition', label: 'Декомпозиция' },
  { key: 'section.metrics', label: 'Метрики (конструктор)' },
  { key: 'section.settings', label: 'Настройки' },
] as const;

export const PERM_ACTIONS = [
  { key: 'action.plans.edit', label: 'Редактирование планов' },
  { key: 'action.users.manage', label: 'Управление пользователями' },
  { key: 'action.shared_reports.manage', label: 'Управление общими отчётами («Смекалочная»)' },
] as const;

export type PermKey =
  | (typeof PERM_SECTIONS)[number]['key']
  | (typeof PERM_ACTIONS)[number]['key'];

export const ALL_PERM_KEYS: PermKey[] = [
  ...PERM_SECTIONS.map((p) => p.key),
  ...PERM_ACTIONS.map((p) => p.key),
];

// Пропускает только ключи из каталога — защита от мусора в roles.permissions
export function sanitizePermissions(raw: unknown): PermKey[] {
  if (!Array.isArray(raw)) return [];
  const valid = new Set<string>(ALL_PERM_KEYS);
  return [...new Set(raw.filter((k): k is PermKey => typeof k === 'string' && valid.has(k)))];
}

export function hasPerm(session: SessionUser | null, key: PermKey): boolean {
  if (!session) return false;
  if (session.isSuperadmin) return true; // супер-админ не может залочить сам себя
  return session.permissions.includes(key);
}

// Для API-роутов: Response с ошибкой либо null, если доступ есть.
// Стандартный Response.json (не NextResponse) — файл импортируется и в клиентских компонентах.
export function permError(session: SessionUser | null, key: PermKey): Response | null {
  if (!session) return Response.json({ error: 'Unauthorized' }, { status: 401 });
  if (!hasPerm(session, key)) return Response.json({ error: 'Forbidden' }, { status: 403 });
  return null;
}

export function superadminError(session: SessionUser | null): Response | null {
  if (!session) return Response.json({ error: 'Unauthorized' }, { status: 401 });
  if (!session.isSuperadmin) return Response.json({ error: 'Forbidden' }, { status: 403 });
  return null;
}

// Первый доступный раздел — цель redirect'а с «/» и из закрытых разделов.
const SECTION_PATHS: Array<{ key: PermKey; path: string }> = [
  { key: 'section.sales', path: '/sales/by-managers' },
  { key: 'section.summary', path: '/summary' },
  { key: 'section.plans', path: '/plans' },
  { key: 'section.decomposition', path: '/decomposition' },
  { key: 'section.marketing', path: '/marketing/brand-contacts' },
  { key: 'section.metrics', path: '/metrics' },
  { key: 'section.settings', path: '/settings' },
];

export function firstAllowedPath(session: SessionUser | null): string {
  if (!session) return '/login';
  for (const s of SECTION_PATHS) {
    if (hasPerm(session, s.key)) return s.path;
  }
  return '/profile'; // ЛК доступен любому залогиненному
}
