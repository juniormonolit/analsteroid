import { QueryProvider } from '@/components/providers/QueryProvider';
import { TooltipProvider } from '@/components/ui/Tooltip';
import { BitrixFrameFit } from '@/components/bitrix/BitrixFrameFit';

// Layout для страниц, встроенных в чужой интерфейс (сейчас — приложение в Битрикс24).
// Отличие от (app): НЕТ AppShell — внутри портала своя навигация, наш сайдбар был бы
// вторым слоем хрома и съедал бы ширину. Провайдеры те же, потому что карточка
// построена на react-query и тултипах.
export default function EmbedLayout({ children }: { children: React.ReactNode }) {
  return (
    <QueryProvider>
      <TooltipProvider>
        <BitrixFrameFit />
        <div className="min-h-dvh bg-[var(--color-bg)]">{children}</div>
      </TooltipProvider>
    </QueryProvider>
  );
}
