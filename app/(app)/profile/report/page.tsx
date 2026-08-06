import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth/session';
import { MyReportPage } from '@/features/reports-builder/ui/MyReportPage';

// «Мой отчёт» — конструктор отчётов (REPORT_CONSTRUCTOR_SPEC.md). Как и весь
// кабинет, правами не гейтится: что человек сможет ВЫБРАТЬ и посчитать, решает
// /api/my-report по managerAccess — менеджеру доступен только он сам.
export default async function Page() {
  const session = await getSession();
  if (!session) redirect('/login');
  return <MyReportPage />;
}
