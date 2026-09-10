import { redirect } from 'next/navigation';
// Раздел «Диагностика» (ТЗ №1). Пока единственный экран — проверки фазы 0.
export default function Page() { redirect('/settings/diagnostics/checks'); }
