import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth/session';
import { canViewDepartmentData } from '@/lib/org/managerAccess';
import { MyTeamPage } from '@/features/profile/ui/MyTeamPage';

// «Мой отдел» (задача 3045, §3). Вид выбирает СЕРВЕР, не фронт: `canViewDepartmentData`
// (роль ИЛИ фактическое руководство отделом по оргструктуре — lib/org/managerAccess.ts)
// решает, руководителя показывать или коллег. Именно так требует §3: «фронт не выбирает
// режим», и роль-гейт по ИМЕНИ роли заменён на охват по оргструктуре — переименование
// роли в справочнике больше не отбирает доступ.
//
// Адрес открыт всем залогиненным (§1: «/profile/team — всем; состав данных решает
// сервер»), поэтому AccessDenied здесь нет: у рядового это его собственный отдел.
export default async function Page() {
  const session = await getSession();
  if (!session) redirect('/login');

  const canLead = await canViewDepartmentData(session);
  return <MyTeamPage canLead={canLead} />;
}
