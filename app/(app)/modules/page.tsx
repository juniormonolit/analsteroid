import { Suspense } from 'react';
import { ModulesPage } from '@/features/client-module/ui/ModulesPage';

export const metadata = { title: 'Модули' };

export default function Page() {
  return <Suspense><ModulesPage /></Suspense>;
}
