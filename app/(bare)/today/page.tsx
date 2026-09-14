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

export default function Page() {
  return <TodayDashboard />;
}
