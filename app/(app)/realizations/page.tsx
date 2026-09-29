import { Suspense } from 'react';
import { RealizationsPage } from '@/features/realizations/ui/RealizationsPage';

export const metadata = { title: 'Заявки и логисты' };

// Suspense — страница читает фильтры из useSearchParams (иначе build требует CSR bailout).
export default function Page() {
  return (
    <Suspense fallback={null}>
      <RealizationsPage />
    </Suspense>
  );
}
