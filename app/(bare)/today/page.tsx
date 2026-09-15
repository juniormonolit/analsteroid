import { TodayDashboard } from '@/features/tv/ui/TodayDashboard';

// Дашборд «Сегодня по компании» — ПУБЛИЧНЫЙ (решение владельца 14.09: «сделай так,
// чтобы /today открывался без пароля»). Та же модель, что у ТВ-экранов: страница и её
// API отдаются без сессии, снаружи закрыты только от роботов (noindex + robots.txt) и
// лимитом запросов на IP. Адрес простой и угадываемый — в отличие от ссылок экранов с
// 16-символьным токеном; если понадобится спрятать, заводить /today/<токен>.
export const metadata = {
  title: 'Сегодня по компании — Монолитика',
  robots: { index: false, follow: false, nocache: true },
};

// force-dynamic (задача #6465): DashboardView теперь читает useSearchParams() (стейт
// drill-down в URL, ?dd=...) — без session-вызова (как у /rop, там getSession() сам
// форсит динамику) страница пыталась статически предрендериться и валила билд
// («useSearchParams() should be wrapped in a suspense boundary»). Странице и так не
// нужен статический HTML — контент целиком клиентский (см. шапку TodayDashboard.tsx).
export const dynamic = 'force-dynamic';

export default function Page() {
  return <TodayDashboard />;
}
