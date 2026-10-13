'use client';
// «Ещё → Модули» (ТЗ владельца 13.10): витрина модулей, которые потом
// встраиваются в Битрикс. Первый — «Карточка клиента»: заказчик ищется по ID
// контакта или компании Битрикса (решение владельца), ниже — превью виджета
// в ширину вкладки карточки Битрикса.

import { useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Search } from 'lucide-react';
import { ClientModuleWidget } from './ClientModuleWidget';
import { BitrixTabBlock } from './BitrixTabBlock';

type Kind = 'contact' | 'company';

export function ModulesPage() {
  const router = useRouter();
  const sp = useSearchParams();
  const urlContact = sp.get('contactId') ?? '';
  const urlCompany = sp.get('companyId') ?? '';

  const [kind, setKind] = useState<Kind>(urlCompany ? 'company' : 'contact');
  const [id, setId] = useState(urlCompany || urlContact);
  useEffect(() => {
    if (urlCompany) { setKind('company'); setId(urlCompany); }
    else if (urlContact) { setKind('contact'); setId(urlContact); }
  }, [urlContact, urlCompany]);

  const clean = id.replace(/\D/g, '');
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!clean) return;
    router.replace(`/modules?${kind === 'company' ? 'companyId' : 'contactId'}=${clean}`);
  };

  return (
    <div className="h-full overflow-y-auto overflow-x-hidden">
      <div className="mx-auto flex max-w-[960px] flex-col gap-4 px-4 py-4 sm:px-6 sm:py-6">
        <div>
          <h1 className="text-lg font-semibold">Модули</h1>
          <p className="mt-0.5 text-[13px] text-[var(--color-text-muted)]">
            Превью модулей до встраивания в Битрикс. Видят только администраторы.
          </p>
        </div>

        <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-surface)] p-3.5">
          <div className="text-[13px] font-semibold">Карточка клиента</div>
          <div className="mt-0.5 text-[12px] text-[var(--color-text-muted)]">
            Встанет вкладкой в карточку контакта/компании Битрикса: отгрузки, LTV, средний чек, цикл повторки,
            товарные группы, объекты (адреса заявок 1С) и ручные поля менеджера.
          </div>
          <form onSubmit={submit} className="mt-3 flex flex-col gap-2 sm:flex-row">
            <div className="flex shrink-0 rounded-lg border border-[var(--color-border)] p-0.5 text-sm">
              {([['contact', 'Контакт'], ['company', 'Компания']] as const).map(([v, l]) => (
                <button key={v} type="button" onClick={() => setKind(v)}
                  className={`min-h-10 flex-1 rounded-md px-3 sm:flex-none ${kind === v ? 'bg-[var(--color-bg-hover)] font-semibold' : 'text-[var(--color-text-muted)]'}`}>{l}</button>
              ))}
            </div>
            <div className="relative min-w-0 flex-1">
              <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--color-text-muted)]" />
              <input value={id} onChange={e => setId(e.target.value)} inputMode="numeric"
                placeholder={kind === 'company' ? 'ID компании в Битриксе' : 'ID контакта в Битриксе'}
                className="h-11 w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] pl-8 pr-3 text-base outline-none focus:border-[var(--color-accent)] sm:text-sm" />
            </div>
            <button type="submit" disabled={!clean} className="min-h-11 rounded-lg bg-[var(--color-accent)] px-4 text-sm font-semibold text-white disabled:opacity-40">
              Открыть
            </button>
          </form>
          <BitrixTabBlock />
        </div>

        {(urlContact || urlCompany) ? (
          // Рамка «как вкладка в карточке Битрикса» — ширина виджета ограничена,
          // чтобы превью честно показывало, как он будет выглядеть там.
          <div className="rounded-xl border border-dashed border-[var(--color-border)] p-2 sm:p-4">
            <div className="mb-2 text-[11px] uppercase tracking-wider text-[var(--color-text-muted)]">Превью виджета</div>
            <div className="mx-auto max-w-[760px]">
              <ClientModuleWidget contactId={urlContact || undefined} companyId={urlCompany || undefined} />
            </div>
          </div>
        ) : (
          <div className="py-8 text-center text-sm text-[var(--color-text-muted)]">Введите ID контакта или компании из Битрикса</div>
        )}
      </div>
    </div>
  );
}
