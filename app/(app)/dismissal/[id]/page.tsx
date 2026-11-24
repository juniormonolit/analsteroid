import { DismissalRunPage } from '@/features/dismissal/ui/DismissalRunPage';

export const metadata = { title: 'Увольнятор — Аналстероид' };

// Гейт доступа — в ../layout.tsx (Администратор / Директор / суперадмин).
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <DismissalRunPage id={id} />;
}
