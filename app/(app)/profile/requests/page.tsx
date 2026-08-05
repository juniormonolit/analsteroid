import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth/session';
import { hasFullManagerAccess, managedDepartmentIds } from '@/lib/org/managerAccess';
import { AccessDenied } from '@/components/ui/AccessDenied';
import { InventoryManageBlock } from '@/features/badges/ui/InventoryManage';
import { PayoutManageBlock } from '@/features/badges/ui/PayoutManage';

// «Заявки» (задача владельца 05.08): всё, что требует решения руководителя, в
// одном месте — активации купленного (отгул, поздний старт и т.п.) и заявки на
// вывод MLT в зарплату. Раньше оба блока жили внутри карточки отдела и
// показывались только когда что-то висит; теперь это отдельный раздел с
// историей «кому что когда активировали» (100 последних решений).
//
// Доступ — тот же рубеж, что у самих API (/api/shop/activate?scope=manage и
// /api/badges/payout): руководство видит всех, РОП — свои отделы. Гейт здесь
// нужен только чтобы не показывать пустую страницу тем, кому решать нечего;
// настоящая проверка прав — на сервере в самих роутах.
export default async function Page() {
  const session = await getSession();
  if (!session) redirect('/login');

  const canManage = hasFullManagerAccess(session) || (await managedDepartmentIds(session)).length > 0;
  if (!canManage) {
    return <AccessDenied reason="Раздел «Заявки» — для руководителей: сюда падают заявки подчинённых на активацию покупок и вывод MLT." />;
  }

  return (
    <div className="mx-auto w-full max-w-[1100px] p-3 sm:p-5 flex flex-col gap-4">
      <div className="flex flex-wrap items-baseline gap-2.5">
        <h1 className="text-xl font-extrabold text-[var(--color-text)]">📋 Заявки</h1>
        <span className="text-[13px] text-[var(--color-text-muted)]">
          решения по активациям и выводам · ниже — история, кому что когда активировали
        </span>
      </div>
      <InventoryManageBlock standalone />
      <PayoutManageBlock standalone />
    </div>
  );
}
