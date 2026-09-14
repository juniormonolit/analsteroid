import { UnsellDealPage } from '@/features/unsell-deal/ui/UnsellDealPage';

export const metadata = { title: 'Снять с продажи — Аналстероид' };

// Гейт — единственный, в layout.tsx рядом (задача #6260): дублировать его
// здесь НЕ стали — на /chats так и сделали (layout.tsx + повторная проверка в
// page.tsx), но там проверка в page.tsx строже проверки в layout.tsx
// (hasPerm без hasFullManagerAccess) — админ без личной выдачи права проходит
// layout, но получает AccessDenied на самой странице. Один гейт — не два
// разных условия на одной странице.
export default function Page() {
  return <UnsellDealPage />;
}
