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
  { key: 'section.charts', label: 'Графики' },
  { key: 'section.metrics', label: 'Метрики (конструктор)' },
  { key: 'section.settings', label: 'Настройки' },
  // «Разгрузка отделов» (задача 2635) — инструмент директора по продажам.
  // Права по паттерну самого закрытого раздела (section.settings): по умолчанию
  // видит ТОЛЬКО супер-админ (hasPerm-байпас), остальным право выдаётся явно
  // через роль в «Настройки → Роли» (ключ появится в чекбоксах автоматически —
  // каталог прав не требует миграции, см. комментарий в шапке файла).
  { key: 'section.offload', label: 'Разгрузка отделов' },
  // «Сотрудники» (задача 2654) — реестр: стаж, ручная дата начала, история
  // переименований битрикс-логина. Тот же паттерн закрытого раздела, что и
  // section.offload: по умолчанию только супер-админ, остальным — через роль.
  { key: 'section.employees', label: 'Сотрудники' },
  // «Презентация» (ТЗ владельца 11.08, BACKLOG «Раздел „Презентация“») —
  // типовые слайды еженедельного собрания. Паттерн закрытого раздела
  // (section.offload): по умолчанию только супер-админ, роли — явно.
  { key: 'section.presentation', label: 'Презентация' },
] as const;

export const PERM_ACTIONS = [
  { key: 'action.plans.edit', label: 'Редактирование планов' },
  { key: 'action.users.manage', label: 'Управление пользователями' },
  { key: 'action.shared_reports.manage', label: 'Управление общими отчётами («Роп монитор», «Отчёты Стаса»)' },
  { key: 'action.deal_chats', label: 'Чаты по сделкам (сообщения менеджерам через бота)' },
  // Задача 2765 (правка владельца 02.08): «директор и выше» видят личные
  // настройки подписки менеджеров на бота «Аналитик» — ТОЛЬКО просмотр, менять
  // чужое нельзя (см. app/api/settings/subscriptions/route.ts). Роль «РОП» эту
  // выдачу НЕ получает по умолчанию — «не должен видеть, кто что отключил»,
  // владелец выдаёт вручную ролям уровня «Директор»+ через «Настройки → Роли».
  { key: 'action.subscriptions.view_all', label: 'Просмотр подписок сотрудников на бота (только чтение)' },
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

// Задача 2990 (правка владельца 04.08, ответ на находку про basic-дефолт): «управленческий
// уровень» — РОП и выше видят «Про» по умолчанию, рядовой менеджер (МОП) — «Обычную».
// Прокси-право `section.plans` («Планы») выбрано осознанно вместо списка имён ролей — по
// факту прод-каталога ролей (см. WORKLOG, задача 2990) оно ровно разделяет управленческие
// роли (РОП, Директор, Администратор — у всех троих есть section.plans) от исполнительских
// (МОП, «Пользователь» — {} / {section.sales,section.charts}, Логист — лателеральная
// функция без section.plans, НЕ управленческая ступень над менеджером). hasPerm() сам
// бесшовно пропускает is_superadmin. Если владелец заведёт новую роль без section.plans, но
// управленческую по смыслу — довыдать ей право явно через «Настройки → Роли», а не
// патчить этот список (тот же принцип, что уже используют section.offload/section.employees).
export function isManagementTier(session: SessionUser | null): boolean {
  return hasPerm(session, 'section.plans') || isReportAdmin(session);
}

// Пункт 3а спеки: тумблер «Обычная/Про». session.uiMode === null означает, что
// пользователь ещё не переключал сам — тогда дефолт по роли (управленческий уровень
// — РОП/Директор/Администратор/супер-админ — → pro, МОП/«Пользователь»/Логист →
// basic). Явное значение в БД (тумблер) ВСЕГДА побеждает дефолт — эта функция решает
// только то, что видит человек, который тумблер ни разу не трогал; проверкой доступа
// к чужим данным или админским действиям isManagementTier()/effectiveUiMode() нигде
// не является (см. isReportAdmin/hasPerm — это отдельные, самостоятельные проверки).
export function effectiveUiMode(session: SessionUser | null): UiMode {
  if (!session) return 'basic';
  if (session.uiMode === 'basic' || session.uiMode === 'pro') return session.uiMode;
  return isManagementTier(session) ? 'pro' : 'basic';
}

// Стартовый адрес — единственное место, решающее «куда человек попадает» с «/»,
// после логина и после приёма инвайта (задача 3045, §5 спеки
// owners-inbox/monolitika-navigation-3045.md).
//
// Правило: нет НИ ОДНОГО раздела (`section.*`) — человеку нечего делать на Главной,
// она будет пустой; его место — личный кабинет. Есть хотя бы один — `/home`, она сама
// адаптируется под права (пустые колонки не рисует).
//
// Раньше здесь был `firstAllowedPath()`, который ВСЕГДА отдавал `/home`: приглашённый
// без прав (в т.ч. автосозданный аккаунт из Битрикса — `lib/bitrix/appAuth.ts`, роль
// «Пользователь» с пустым набором прав) попадал на пустую главную и решал, что
// приложение сломано.
//
// Режим запуска (`lib/hooks/useAppMode.ts`) здесь СОЗНАТЕЛЬНО не участвует, хотя §5
// спеки описывает поведение по режимам: это серверная функция, а режим — клиентское
// понятие (iframe/standalone видно только в браузере). Две режимные ветки закрыты
// там, где им место: Битрикс — обработчиком входа (`/api/bitrix/app` уводит на
// `/bx/manager`, вне `/bx/*` портал получит белый экран из-за CSP frame-ancestors),
// установленное PWA — `start_url` в `app/manifest.ts`. Для mobile/desktop таблица §5
// совпадает с правилом ниже, отдельная ветка не нужна.
export function landingFor(session: SessionUser | null): string {
  if (!session) return '/login';
  const hasAnySection = PERM_SECTIONS.some((p) => hasPerm(session, p.key));
  return hasAnySection ? '/home' : '/profile';
}
