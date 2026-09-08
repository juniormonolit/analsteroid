import { QueryProvider } from '@/components/providers/QueryProvider';
import { TooltipProvider } from '@/components/ui/Tooltip';

// «Голые» страницы Монолитики: без AppShell/меню, только провайдеры. Сессию и права
// проверяет сама страница. Первый жилец — дашборд «Сегодня по компании» (/today,
// правка владельца 08.09: «в Монолитике за отдельным урл, но без меню, только дашборд»).
export default function BareLayout({ children }: { children: React.ReactNode }) {
  return (
    <QueryProvider>
      <TooltipProvider>
        <div className="min-h-dvh bg-[var(--color-bg)] text-[var(--color-text)]">{children}</div>
      </TooltipProvider>
    </QueryProvider>
  );
}
