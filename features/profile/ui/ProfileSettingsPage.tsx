'use client';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { KeyRound, LayoutGrid, Moon, Rows3 } from 'lucide-react';
import { Avatar } from '@/components/ui/Avatar';
import { ChangePasswordModal } from './ChangePasswordModal';
import { useUiMode, type UiMode } from '@/lib/hooks/useUiMode';
import { useTableScale, type TableScalePct } from '@/lib/hooks/useTableScale';
import { useTheme, THEME_LABEL, THEME_ORDER } from '@/lib/hooks/useTheme';
import { useUrlState, enumParam } from '@/lib/hooks/useUrlState';
import { ReportsTrashCard } from '@/features/reports/ui/ReportsTrashCard';
import { BotSubscriptionSettings } from './BotSubscriptionSettings';
import { RopDigestSettings } from './RopDigestSettings';
import { MyFeedbackLog } from './MyFeedbackLog';
import { PinSettingsCard } from './PinSettingsCard';
import { DirectAccessCard } from './DirectAccessCard';
import { AppearanceSettings } from './AppearanceSettings';

// Личные настройки (задача 3045, §1: `/profile/settings?tab=personal|notifications`,
// модалка пароля — `?modal=password`). Раньше это была вся страница `/profile` с
// четырьмя вкладками на локальном `useState`; ЛК-карточка забрала себе `/profile`,
// «Мой отдел» уехал на `/profile/team`, здесь остались настройки САМОГО СЕБЯ.
//
// Вкладка и модалка — в URL (`useUrlState`, правило адресуемости из
// DESIGN_GUIDELINES.md): ссылку на вкладку можно прислать, «назад» закрывает
// модалку, а не уводит со страницы.
interface Me {
  user: {
    login: string;
    displayName: string;
    roleName: string;
    rawRoleName: string | null;
    isSuperadmin: boolean;
    avatarUrl: string | null;
    bitrixUserId: string | null;
  };
  departments: { id: string; name: string }[];
}




const cardCls = 'rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-surface)] p-4 sm:p-5';

// Вкладки (задача 2051 — «простыня» из 8 карточек стала шапкой + вкладками; задача
// 3045 — вкладок осталось две, «Мой отдел» и корзина уехали на свои адреса). Навигация —
// тот же паттерн, что SettingsSidebar в /settings: вертикальная рельса на md+,
// горизонтальные табы на телефоне.
const PROFILE_TABS = ['personal', 'appearance', 'notifications'] as const;
type ProfileTab = (typeof PROFILE_TABS)[number];

export function ProfileSettingsPage() {
  // Вкладка — push: смысловой шаг истории, браузерный «назад» должен возвращать на
  // предыдущую вкладку (п.3 контракта useUrlState).
  const [tab, setTab] = useUrlState<ProfileTab>('tab', { ...enumParam(PROFILE_TABS, 'personal'), mode: 'push' });
  // Модалка пароля — тоже в адресе (§1 спеки: `?modal=password`). Так на неё можно
  // дать прямую ссылку, а «назад» её закрывает, вместо ухода со страницы.
  const [modal, setModal] = useUrlState<'none' | 'password'>('modal', { ...enumParam(['none', 'password'] as const, 'none'), mode: 'push' });
  const showPassword = modal === 'password';

  // Тумблер «Про/Лайт» (п.3а спеки; переименование «Обычная»→«Лайт» — правка 09.07/2,
  // п.1) — общий хук с компактным тумблером в сайдбаре (AppShell), тот же серверный
  // ui_mode/queryKey.
  const { uiMode, setUiMode } = useUiMode();
  // Масштаб таблиц (бриф 09.07, п.3): персональная настройка отображения — вместе с
  // Про/Лайт живёт в ЛК (переехало сюда из «настроек отчёта», см. WORKLOG задачи —
  // там раньше был локальный, непер­систентный «Размер шрифта» на localStorage).
  const { tableScalePct, setTableScale } = useTableScale();
  // Тёмная тема (макет owners-inbox/analsteroid-dark-theme-mock.html, утверждён
  // владельцем) — тот же серверный паттерн, что и масштаб таблиц (users.theme,
  // migration 070). Анти-вспышка при загрузке — инлайн-скрипт в app/layout.tsx.
  const { theme, setTheme, error: themeError } = useTheme();

  const { data: me, isLoading: meLoading } = useQuery<Me>({
    queryKey: ['me'],
    queryFn: async () => {
      const res = await fetch('/api/me');
      if (!res.ok) throw new Error('unauthorized');
      return res.json();
    },
    staleTime: 5 * 60_000,
  });

  const tabs: { key: ProfileTab; label: string }[] = [
    { key: 'personal', label: 'Персонализация' },
    // «Оформление» — слово владельца (06.08). Отдельно от «Персонализации»
    // намеренно: та про ИНТЕРФЕЙС (режим отчётов, масштаб таблиц, тема), а эта
    // про то, как выглядит профиль для коллег — обложка, рамка, фон.
    { key: 'appearance', label: 'Оформление' },
    { key: 'notifications', label: 'Уведомления' },
  ];

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* Шапка-идентичность: «who am I» — не настройка, видна всегда, не скроллится
          с контентом вкладки (паттерн GitHub/Linear account settings). */}
      <div className="shrink-0 border-b border-[var(--color-border)] bg-[var(--color-bg-surface)] px-3 sm:px-6 py-3 sm:py-4">
        <h1 className="text-lg font-semibold text-[var(--color-text)] mb-3">Настройки</h1>
        {meLoading ? (
          <div className="text-sm text-[var(--color-text-muted)]">Загрузка...</div>
        ) : me ? (
          <div className="flex flex-col sm:flex-row sm:items-center gap-3 sm:gap-4">
            <div className="flex items-center gap-3 sm:gap-4 flex-1 min-w-0">
              <Avatar name={me.user.displayName} url={me.user.avatarUrl} size={48} />
              <div className="min-w-0">
                <div className="text-base font-semibold text-[var(--color-text)] truncate">{me.user.displayName}</div>
                <div className="text-sm text-[var(--color-text-muted)] truncate">
                  @{me.user.login} · {me.user.roleName}
                </div>
              </div>
            </div>
            <div className="flex items-center gap-2 shrink-0 flex-wrap">
              {/* Кнопки «Мой ЛК» здесь больше нет: кабинет — соседняя вкладка рельсы
                  ЛК (задача 3045), вторая кнопка в ту же сторону только путала. */}
              <button
                onClick={() => setModal('password')}
                className="flex items-center justify-center gap-2 px-4 py-2 text-sm border border-[var(--color-border)] rounded-lg text-[var(--color-text)] hover:border-[var(--color-border-focus)] transition-colors"
              >
                <KeyRound size={15} />
                Сменить пароль
              </button>
            </div>
          </div>
        ) : (
          <div className="text-sm text-red-500">Не удалось загрузить профиль</div>
        )}
      </div>

      {/* Тело: рельса вкладок (md+) / горизонтальные табы (телефон) + контент.
          Раскладка и классы — как app/(app)/settings/layout.tsx + SettingsSidebar. */}
      <div className="flex flex-col md:flex-row flex-1 overflow-hidden">
        <aside className="md:w-60 shrink-0 border-b md:border-b-0 md:border-r border-[var(--color-border)] bg-[var(--color-bg-surface)]">
          <nav className="flex md:flex-col py-1.5 md:py-2 overflow-x-auto">
            {tabs.map(t => (
              <button
                key={t.key}
                onClick={() => setTab(t.key)}
                className={`block text-left whitespace-nowrap shrink-0 px-3 md:px-4 py-2 text-sm rounded-md mx-1 md:mx-2 my-0.5 transition-colors ${
                  tab === t.key
                    ? 'bg-[var(--color-accent)]/10 text-[var(--color-accent)] font-medium'
                    : 'text-[var(--color-text)] hover:bg-[var(--color-border)]'
                }`}
              >
                {t.label}
              </button>
            ))}
          </nav>
        </aside>

        <div className="flex-1 overflow-y-auto min-w-0">
          {/* Ширина колонки — задача 1681 (аудит широких экранов): клампованная
              центрированная колонка (--content-col, app/globals.css), активна с md. */}
          <div className="p-3 sm:p-6 md:mx-auto md:w-[var(--content-col)] flex flex-col gap-4">
            {tab === 'personal' && (
              <>
                {/* Режим интерфейса: Обычная/Про (п.3а спеки) */}
                <div className={cardCls}>
                  <div className="flex items-center gap-2 mb-2">
                    <LayoutGrid size={15} className="text-[var(--color-text-muted)]" />
                    <h2 className="text-sm font-semibold text-[var(--color-text)]">Режим интерфейса отчётов</h2>
                  </div>
                  <p className="text-sm text-[var(--color-text-muted)] mb-3">
                    «Про» — полный набор инструментов (фильтры, вид, сохранение отчётов, настройка колонок,
                    перетаскивание). «Лайт» — упрощённый вид: период, отделы, группировка, поиск.
                  </p>
                  <div className="flex border border-[var(--color-border)] rounded-lg overflow-hidden text-sm w-fit">
                    {(['basic', 'pro'] as UiMode[]).map(m => (
                      <button
                        key={m}
                        onClick={() => setUiMode(m)}
                        className={`px-4 py-1.5 transition-colors ${
                          uiMode === m
                            ? 'bg-[var(--color-accent)] text-[var(--color-text-inverse)]'
                            : 'text-[var(--color-text)] hover:bg-[var(--color-bg-hover)]'
                        }`}
                      >
                        {m === 'basic' ? 'Лайт' : 'Про'}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Масштаб таблиц (бриф 09.07, п.3): применяется ко всем таблицам отчётов
                    (основная, дрилл-даун, список сделок) — кегль и высота строк масштабируются
                    пропорционально от базовых 30px/100%. Персистится на юзере (users.table_scale). */}
                <div className={cardCls}>
                  <div className="flex items-center gap-2 mb-2">
                    <Rows3 size={15} className="text-[var(--color-text-muted)]" />
                    <h2 className="text-sm font-semibold text-[var(--color-text)]">Масштаб таблиц</h2>
                  </div>
                  <p className="text-sm text-[var(--color-text-muted)] mb-3">
                    Размер шрифта и высота строк во всех таблицах отчётов — основной, дрилл-дауне,
                    списке сделок.
                  </p>
                  <div className="flex border border-[var(--color-border)] rounded-lg overflow-hidden text-sm w-fit">
                    {([85, 100, 115] as TableScalePct[]).map(p => (
                      <button
                        key={p}
                        onClick={() => setTableScale(p)}
                        className={`px-4 py-1.5 transition-colors ${
                          tableScalePct === p
                            ? 'bg-[var(--color-accent)] text-[var(--color-text-inverse)]'
                            : 'text-[var(--color-text)] hover:bg-[var(--color-bg-hover)]'
                        }`}
                      >
                        {p}%
                      </button>
                    ))}
                  </div>
                </div>

                {/* Тема оформления. ЧЕТЫРЕ положения (04.08, решение владельца):
                    «Классическая» — вид приложения до редизайна, она же по умолчанию
                    у всех; три стеклянные темы дизайн-системы «Монолитика Glass»
                    (задача 2999) — светлая, тёмно-синяя и серая, у серой палитра
                    графиков сворачивается в серую шкалу, но статусы и тиры остаются
                    цветными. Значения в БД прежние (classic/light/dark/mono), в
                    интерфейсе — названия владельца, см. THEME_LABEL.
                    Плитками с переносом, а не сегментированной полосой: четыре
                    длинных названия в одну строку на 375px не влезают (CLAUDE.md,
                    правило 12 — flex-wrap вместо горизонтального скролла). */}
                <div className={cardCls}>
                  <div className="flex items-center gap-2 mb-2">
                    <Moon size={15} className="text-[var(--color-text-muted)]" />
                    <h2 className="text-sm font-semibold text-[var(--color-text)]">Тема оформления</h2>
                  </div>
                  <p className="text-sm text-[var(--color-text-muted)] mb-3">
                    Применяется сразу и запоминается на этом аккаунте.
                  </p>
                  <div className="flex flex-wrap gap-2 text-sm">
                    {THEME_ORDER.map(t => (
                      <button
                        key={t}
                        onClick={() => setTheme(t)}
                        className={`min-h-11 rounded-lg border px-4 py-1.5 transition-colors ${
                          theme === t
                            ? 'border-[var(--color-accent)] bg-[var(--color-accent)] text-[var(--color-text-inverse)]'
                            : 'border-[var(--color-border)] text-[var(--color-text)] hover:bg-[var(--color-bg-hover)]'
                        }`}
                      >
                        {THEME_LABEL[t]}
                      </button>
                    ))}
                  </div>
                  {/* Ошибка сохранения раньше была невидимой: тема мигала и
                      откатывалась, и это выглядело как баг темы, а не как отказ
                      сервера (живой инцидент с «Серым стеклом» — в БД не было
                      значения в CHECK, PATCH падал 500). */}
                  {themeError && (
                    <p className="mt-2 text-xs text-[var(--color-negative)]">{themeError}</p>
                  )}
                </div>

                {/* Пин-код на денежные операции (задача #2995) */}
                <PinSettingsCard ssoAccount={/^bx\d+$/.test(me?.user.login ?? '')} />

                {/* Доступ по прямой ссылке (сценарий владельца 05.08): вошёл через
                    Битрикс → получил ссылку → задал пароль → сохранил как приложение.
                    Показываем ВСЕМ: у людей, заведённых из Битрикса (логин bx<id>),
                    пароля нет вовсе, а остальным даёт способ перевыпустить свой. */}
                <DirectAccessCard />

                {/* Корзина СВОИХ отчётов (задача 3045, §4). Общая корзина уехала на
                    /settings/trash под право section.settings — но рядовой менеджер
                    вправе восстанавливать свои удалённые отчёты (так и работает API),
                    и другого пути к ним у него нет. Тот же компонент: он и раньше
                    показывал витринные только админу, сервер фильтрует сам. */}
                <ReportsTrashCard />
              </>
            )}

            {tab === 'appearance' && (
              <AppearanceSettings
                name={me?.user.displayName ?? '?'}
                avatarUrl={me?.user.avatarUrl ?? null}
              />
            )}

            {tab === 'notifications' && (
              /* Личные настройки подписки на бота «Аналитик» (задача 2765, 02.08) —
                 «это его личка», настройки видны и редактируемы только самим менеджером.
                 Плюс личный журнал сигналов «Мои замечания» — своё, ниже настроек.
                 RopDigestSettings (задача 2769) — дайджест отдела, сам себя скрывает
                 для не-РОПов (isRop=false), рендерится всегда, без серверного гейта. */
              <div className="flex flex-col gap-4">
                <BotSubscriptionSettings />
                <RopDigestSettings />
                <MyFeedbackLog />
              </div>
            )}
          </div>
        </div>
      </div>

      {showPassword && <ChangePasswordModal onClose={() => setModal('none')} />}
    </div>
  );
}
