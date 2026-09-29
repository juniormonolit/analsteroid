import { redirect } from 'next/navigation';

// «Реализация» (задача #8126, находка 9): каждый отчёт — свой пункт меню и адрес.
// Старый адрес «Заявки и логисты» (/realizations?tab=…) ведёт на новый отчёт
// с теми же фильтрами; период from/to переводится на страницы «Заявки».
export default async function Page({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) if (typeof v === 'string' && k !== 'tab') qs.set(k, v);
  const tab = typeof sp.tab === 'string' ? sp.tab : '';
  const base = tab === 'logists' ? '/realizations/logists' : tab === 'regions' ? '/realizations/regions' : '/realizations/requests';
  const q = qs.toString();
  redirect(q ? `${base}?${q}` : base);
}
