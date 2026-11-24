import { DismissalListPage } from '@/features/dismissal/ui/DismissalListPage';

export const metadata = { title: 'Увольнятор — Аналстероид' };

// Гейт доступа — в layout.tsx (Администратор / Директор / суперадмин).
export default function Page() {
  return <DismissalListPage />;
}
