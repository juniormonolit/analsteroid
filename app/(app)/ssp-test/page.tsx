import { SspTestPage } from '@/features/decomposition/ui/SspTestPage';

// Заголовок вкладки браузера (правка владельца 10.10). Бренд — «Монолитика», как в корневом
// layout.tsx; старое «— Аналстероид» на части страниц осталось от прежнего названия.
export const metadata = { title: 'ССП: план и факт — Монолитика' };

export default function Page() {
  return <SspTestPage />;
}
