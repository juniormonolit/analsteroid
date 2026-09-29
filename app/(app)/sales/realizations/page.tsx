import { Suspense } from 'react';
import { RealizationsPage } from '@/features/realizations/ui/RealizationsPage';

export const metadata = { title: 'Реализация' };

// Suspense — страница читает фильтры из useSearchParams (иначе build требует CSR bailout).
export default function Page() {
  return (
    <Suspense fallback={null}>
      <RealizationsPage />
    </Suspense>
  );
}
