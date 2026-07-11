'use client';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Bell, IdCard, KeyRound, LayoutGrid, Moon, Rows3 } from 'lucide-react';
import { startOfMonth } from 'date-fns';
import { Avatar } from '@/components/ui/Avatar';
import { ChangePasswordModal } from './ChangePasswordModal';
import { useUiMode, type UiMode } from '@/lib/hooks/useUiMode';
import { useTableScale, type TableScalePct } from '@/lib/hooks/useTableScale';
import { useTheme, type Theme } from '@/lib/hooks/useTheme';
import { DeptRosterGrid } from './DeptRosterGrid';
import { ManagerCardPanel } from '@/features/manager-card/ui/ManagerCardPanel';

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

// Карточка менеджера v2 (бриф 10.07): роли, которым видна ФИФА-сетка «Мой отдел» —
// РОП/Директор/Администратор + супер-админ (см. app/api/manager-card/team/route.ts —
// та же граница проверяется и на сервере, здесь только решение не рендерить блок).
const ROSTER_ROLES = new Set(['РОП', 'Директор', 'Администратор']);

interface DeptSummary {
  month: string; // YYYY-MM-01
  workingDays: { inMonth: number; passed: number };
  departments: {
    departmentId: string;
    name: string;
    planShipments: number;
    factShipments: number;
    pctPlan: number | null;
    pctPace: number | null;
  }[];
  total: { planShipments: number; factShipments: number; pctPlan: number | null; pctPace: number | null };
}

function fmtMoney(v: number): string {
  return v.toLocaleString('ru-RU', { maximumFractionDigits: 0 });
}

function fmtPct(v: number | null): string {
  return v === null ? '—' : `${v.toLocaleString('ru-RU', { maximumFractionDigits: 1 })}%`;
}

function pctClass(v: number | null): string {
  if (v === null) return 'text-[var(--color-text-muted)]';
  if (v >= 100) return 'text-green-600';
  if (v >= 80) return 'text-[var(--color-text)]';
  return 'text-red-500';
}

const MONTH_NAMES = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'];

function monthTitle(month: string): string {
  const [y, m] = month.split('-');
  const name = MONTH_NAMES[parseInt(m, 10) - 1] ?? '';
  return `${name} ${y}`;
}

const cardCls = 'rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-surface)] p-4 sm:p-5';

export function ProfilePage() {
  const [showPassword, setShowPassword] = useState(false);
  const [showMyCard, setShowMyCard] = useState(false);

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
  const { theme, setTheme } = useTheme();

  const { data: me, isLoading: meLoading } = useQuery<Me>({
    queryKey: ['me'],
    queryFn: async () => {
      const res = await fetch('/api/me');
      if (!res.ok) throw new Error('unauthorized');
      return res.json();
    },
    staleTime: 5 * 60_000,
  });

  const hasDepartments = (me?.departments.length ?? 0) > 0;

  const { data: summary, isLoading: summaryLoading } = useQuery<DeptSummary>({
    queryKey: ['me-dept-summary'],
    queryFn: async () => {
      const res = await fetch('/api/me/dept-summary');
      if (!res.ok) throw new Error('failed');
      return res.json();
    },
    enabled: hasDepartments,
    staleTime: 5 * 60_000,
  });

  return (
    <div className="h-full overflow-y-auto">
      {/* Ширина колонки — задача 1681 (аудит широких экранов): было max-w-3xl
          (768px, фиксированный px, без центрирования) — контент прижимало к
          левому краю, на 2560px пустовало 66% рабочей зоны. Теперь клампованная
          центрированная колонка (--content-col, app/globals.css), активна с md
          (768px) — ниже сайдбар скрыт (drawer), контейнер и так занимает всю
          доступную ширину, поведение на мобильном не меняется. */}
      <div className="p-3 sm:p-6 md:mx-auto md:w-[var(--content-col)] flex flex-col gap-4">
        <h1 className="text-lg font-semibold text-[var(--color-text)]">Личный кабинет</h1>

        {/* Профиль */}
        <div className={cardCls}>
          {meLoading ? (
            <div className="text-sm text-[var(--color-text-muted)]">Загрузка...</div>
          ) : me ? (
            <div className="flex flex-col sm:flex-row sm:items-center gap-4">
              <div className="flex items-center gap-4 flex-1 min-w-0">
                <Avatar name={me.user.displayName} url={me.user.avatarUrl} size={64} />
                <div className="min-w-0">
                  <div className="text-base font-semibold text-[var(--color-text)] truncate">{me.user.displayName}</div>
                  <div className="text-sm text-[var(--color-text-muted)] truncate">@{me.user.login}</div>
                  <div className="text-xs text-[var(--color-text-muted)] mt-0.5">{me.user.roleName}</div>
                </div>
              </div>
              <div className="flex items-center gap-2 shrink-0 flex-wrap">
                {/* МОП: своя карточка менеджера в ЛК (карточка менеджера v2, бриф 10.07, п.2).
                    Маппинг юзер→менеджер — users.bitrix_user_id === org_resolved_hierarchy.
                    manager_bitrix_user_id (уже используется для аватара/сессии, отдельная
                    таблица не заводилась — см. отчёт задачи). */}
                {me.user.rawRoleName === 'МОП' && me.user.bitrixUserId && (
                  <button
                    onClick={() => setShowMyCard(true)}
                    className="flex items-center justify-center gap-2 px-4 py-2 text-sm border border-[var(--color-border)] rounded-lg text-[var(--color-text)] hover:border-[var(--color-border-focus)] transition-colors"
                  >
                    <IdCard size={15} />
                    Моя карточка
                  </button>
                )}
                <button
                  onClick={() => setShowPassword(true)}
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

        {/* Тема оформления (макет утверждён владельцем, дефолт — светлая) */}
        <div className={cardCls}>
          <div className="flex items-center gap-2 mb-2">
            <Moon size={15} className="text-[var(--color-text-muted)]" />
            <h2 className="text-sm font-semibold text-[var(--color-text)]">Тема оформления</h2>
          </div>
          <p className="text-sm text-[var(--color-text-muted)] mb-3">
            Применяется сразу и запоминается на этом аккаунте.
          </p>
          <div className="flex border border-[var(--color-border)] rounded-lg overflow-hidden text-sm w-fit">
            {(['light', 'dark'] as Theme[]).map(t => (
              <button
                key={t}
                onClick={() => setTheme(t)}
                className={`px-4 py-1.5 transition-colors ${
                  theme === t
                    ? 'bg-[var(--color-accent)] text-[var(--color-text-inverse)]'
                    : 'text-[var(--color-text)] hover:bg-[var(--color-bg-hover)]'
                }`}
              >
                {t === 'light' ? 'Светлая' : 'Тёмная'}
              </button>
            ))}
          </div>
        </div>

        {/* Подконтрольные отделы */}
        <div className={cardCls}>
          <div className="flex items-baseline justify-between gap-2 mb-3 flex-wrap">
            <h2 className="text-sm font-semibold text-[var(--color-text)]">Подконтрольные отделы</h2>
            {summary && hasDepartments && (
              <span className="text-xs text-[var(--color-text-muted)]">
                Отгрузки, {monthTitle(summary.month)} (МСК) · раб. дней: {summary.workingDays.passed} из {summary.workingDays.inMonth}
              </span>
            )}
          </div>

          {meLoading || (hasDepartments && summaryLoading) ? (
            <div className="text-sm text-[var(--color-text-muted)]">Загрузка...</div>
          ) : !hasDepartments ? (
            <p className="text-sm text-[var(--color-text-muted)]">
              Отделы не назначены. Обратитесь к администратору.
            </p>
          ) : summary ? (
            <div className="scroll-x -mx-4 sm:mx-0 px-4 sm:px-0">
              <table className="w-full min-w-[520px] text-sm">
                <thead>
                  <tr className="border-b border-[var(--color-border)] text-left text-[var(--color-text-muted)]">
                    <th className="py-2 pr-3 font-medium">Отдел</th>
                    <th className="py-2 px-3 font-medium text-right">План</th>
                    <th className="py-2 px-3 font-medium text-right">Факт</th>
                    <th className="py-2 px-3 font-medium text-right">% план</th>
                    <th className="py-2 pl-3 font-medium text-right">% темп</th>
                  </tr>
                </thead>
                <tbody>
                  {summary.departments.map((d) => (
                    <tr key={d.departmentId} className="border-b border-[var(--color-border)] last:border-0">
                      <td className="py-2 pr-3 text-[var(--color-text)]">{d.name}</td>
                      <td className="py-2 px-3 text-right text-[var(--color-text-muted)] whitespace-nowrap">{fmtMoney(d.planShipments)}</td>
                      <td className="py-2 px-3 text-right text-[var(--color-text)] whitespace-nowrap">{fmtMoney(d.factShipments)}</td>
                      <td className={`py-2 px-3 text-right whitespace-nowrap ${pctClass(d.pctPlan)}`}>{fmtPct(d.pctPlan)}</td>
                      <td className={`py-2 pl-3 text-right whitespace-nowrap ${pctClass(d.pctPace)}`}>{fmtPct(d.pctPace)}</td>
                    </tr>
                  ))}
                  {summary.departments.length > 1 && (
                    <tr className="font-medium">
                      <td className="py-2 pr-3 text-[var(--color-text)]">Итого</td>
                      <td className="py-2 px-3 text-right text-[var(--color-text-muted)] whitespace-nowrap">{fmtMoney(summary.total.planShipments)}</td>
                      <td className="py-2 px-3 text-right text-[var(--color-text)] whitespace-nowrap">{fmtMoney(summary.total.factShipments)}</td>
                      <td className={`py-2 px-3 text-right whitespace-nowrap ${pctClass(summary.total.pctPlan)}`}>{fmtPct(summary.total.pctPlan)}</td>
                      <td className={`py-2 pl-3 text-right whitespace-nowrap ${pctClass(summary.total.pctPace)}`}>{fmtPct(summary.total.pctPace)}</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="text-sm text-red-500">Не удалось собрать сводку</div>
          )}
        </div>

        {/* ФИФА-сетка «Мой отдел» (карточка менеджера v2, п.1) — только РОП/Директор/
            Администратор/супер-админ; для Пользователя/МОП блок не рендерится вовсе
            (сервер /api/manager-card/team всё равно ещё раз проверяет роль). */}
        {me && (me.user.isSuperadmin || (me.user.rawRoleName && ROSTER_ROLES.has(me.user.rawRoleName))) && (
          <DeptRosterGrid />
        )}

        {/* Уведомления — заглушка под будущий конструктор */}
        <div className={cardCls}>
          <div className="flex items-center gap-2 mb-2">
            <Bell size={15} className="text-[var(--color-text-muted)]" />
            <h2 className="text-sm font-semibold text-[var(--color-text)]">Уведомления от бота «Аналитик»</h2>
            <span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-[var(--color-accent)]/10 text-[var(--color-accent)]">
              скоро
            </span>
          </div>
          <p className="text-sm text-[var(--color-text-muted)] mb-3">
            Здесь появится конструктор уведомлений: бот «Аналитик» будет автоматически присылать
            в Битрикс сообщение, когда показатель отклонится от нормы — аномалия, резкое снижение
            или рост, отставание от плана.
          </p>
          <label className="flex items-center gap-2 opacity-50 cursor-not-allowed select-none">
            <input type="checkbox" disabled className="accent-[var(--color-accent)] w-4 h-4" />
            <span className="text-sm text-[var(--color-text)]">Получать уведомления</span>
          </label>
        </div>
      </div>

      {showPassword && <ChangePasswordModal onClose={() => setShowPassword(false)} />}
      {showMyCard && me?.user.bitrixUserId && (
        <ManagerCardPanel
          managerId={me.user.bitrixUserId}
          managerName={me.user.displayName}
          reportPeriod={{ from: startOfMonth(new Date()), to: new Date() }}
          onClose={() => setShowMyCard(false)}
        />
      )}
    </div>
  );
}
