import { Suspense } from 'react';
import { MyRequestsPage } from '@/features/logist-kanban/ui/MyRequestsPage';

// «Запросы логистам» в ЛК (S5): свои запросы менеджера + вкладка «Аналитика» РОПам / руководителю логистики.
// Правами не гейтится (ЛК открыт всем вошедшим): API отдаёт только свои запросы, аналитику — по ropScope / canManage.
export const metadata = {
  title: 'Запросы логистам — Монолитика',
  robots: { index: false, follow: false, nocache: true },
};

export default function Page() {
  return <Suspense><MyRequestsPage /></Suspense>;
}
