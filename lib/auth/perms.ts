import type { SessionUser } from './session';

// Каталог прав. БД (roles.permissions) хранит только выбранные ключи —
// неизвестные ключи игнорируются, так что добавление нового ключа не требует миграции.

export const PERM_SECTIONS = [
  { key: 'section.sales', label: 'Продажи' },
  { key: 'section.realization', label: 'Реализация' },
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
  { key: 'action.shared_reports.manage', label: 'Управление общими отчётами («Роп монитор», «Отчёты Стаса»)' },
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

export type SectionKey = (typeof PERM_SECTIONS)[number]['key'];

// Права v2: персональные исключения (users.section_overrides, миграция 067) —
// только section.* ключи, action.* сюда не допускаются (действия остаются
// исключительно правом роли, не персональным исключением).
export function sanitizeSectionOverrides(raw: unknown): SectionKey[] {
  if (!Array.isArray(raw)) return [];
  const valid = new Set<string>(PERM_SECTIONS.map((p) => p.key));
  return [...new Set(raw.filter((k): k is SectionKey => typeof k === 'string' && valid.has(k)))];
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

// «Админ» в контексте общих витрин отчётов (п.3б спеки) — тот же уровень, что уже
// используется для «Смекалочной»: право action.shared_reports.manage (даёт его роль
// «Администратор», плюс супер-админ всегда проходит через hasPerm).
export function isReportAdmin(session: SessionUser | null): boolean {
  return hasPerm(session, 'action.shared_reports.manage');
}

export type UiMode = 'basic' | 'pro';

// Пункт 3а спеки: тумблер «Обычная/Про». session.uiMode === null означает, что
// пользователь ещё не переключал сам — тогда дефолт по роли (администратор → pro,
// остальные → basic). Явное значение в БД всегда побеждает дефолт.
export function effectiveUiMode(session: SessionUser | null): UiMode {
  if (!session) return 'basic';
  if (session.uiMode === 'basic' || session.uiMode === 'pro') return session.uiMode;
  return isReportAdmin(session) ? 'pro' : 'basic';
}

// Цель redirect'а с «/», после логина и из закрытых разделов (нет нужного
// section.*-права). Раньше вело на первый доступный раздел по списку прав;
// с появлением Главной (owners-inbox/home-page брифа) она сама адаптируется
// под права пользователя (пустые колонки, если прав нет), поэтому это
// универсальный безопасный fallback для любого залогиненного пользователя.
export function firstAllowedPath(session: SessionUser | null): string {
  return session ? '/home' : '/login';
}
