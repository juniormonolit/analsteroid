import { ResponsesTabs } from '@/features/realizations/ui/ResponsesTabs';

// «Реализация → Ответы на запросы»: общая лента вкладок над четырьмя страницами
// (Снабженцы / Категории / Товары / Доля запросов). Страницы ниже — сами h-full
// с прокруткой, поэтому тело — flex-1 min-h-0.
export default function ResponsesLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full min-h-0 flex-col overflow-x-hidden">
      <ResponsesTabs />
      <div className="min-h-0 flex-1">{children}</div>
    </div>
  );
}
