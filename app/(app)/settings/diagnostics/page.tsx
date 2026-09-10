import { redirect } from 'next/navigation';
// Раздел «Диагностика» (ТЗ №1). Пункт настроек ведёт на экран диагностики; проверки фазы 0 — /settings/diagnostics/checks.
export default function Page() { redirect('/diagnostics'); }
