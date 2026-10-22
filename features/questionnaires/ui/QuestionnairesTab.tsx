'use client';
// «Что предложить» → «Анкеты» (миграция 244, владелец 22.10): для каждой товарной группы — своя
// анкета (вопросы с типом ответа). Список групп + «Общие вопросы» для любого заказчика; клик —
// редактор. Менеджеры заполнят анкету в брифе карточки клиента (следующий этап).
import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ClipboardList, Pencil } from 'lucide-react';
import { COMMON_GROUP, type GroupQuestion } from '../engine/types';
import { QuestionnaireEditor } from './QuestionnaireEditor';

const COMMON_LABEL = 'Общие вопросы — для любого заказчика';
const labelOf = (g: string) => (g === COMMON_GROUP ? COMMON_LABEL : g);
const vopros = (n: number) => {
  const m10 = n % 10, m100 = n % 100;
  return m10 === 1 && m100 !== 11 ? 'вопрос' : m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20) ? 'вопроса' : 'вопросов';
};

export function QuestionnairesTab({ groups }: { groups: string[] }) {
  const qc = useQueryClient();
  const [q, setQ] = useState('');
  const [onlyFilled, setOnlyFilled] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const { data, error, isLoading } = useQuery<Record<string, GroupQuestion[]>, Error>({
    queryKey: ['group-questionnaires'],
    queryFn: async () => {
      const r = await fetch('/api/settings/cross-sell/questions');
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error ?? `Ошибка ${r.status}`);
      return j.questionnaires as Record<string, GroupQuestion[]>;
    },
  });
  const all = data ?? {};
  // Группа могла пропасть из матрицы, а анкета у неё есть — показываем всё равно.
  const list = useMemo(() => {
    const names = [...new Set([...groups, ...Object.keys(all).filter(g => g !== COMMON_GROUP)])].sort((a, b) => a.localeCompare(b, 'ru'));
    return [COMMON_GROUP, ...names];
  }, [groups, all]);
  const needle = q.trim().toLowerCase();
  const shown = list.filter(g => (!needle || labelOf(g).toLowerCase().includes(needle)) && (!onlyFilled || (all[g]?.length ?? 0) > 0));
  const filled = list.filter(g => (all[g]?.length ?? 0) > 0).length;

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <p className="text-xs leading-relaxed text-[var(--color-text-muted)]">
        Анкета — вопросы, которые менеджер задаёт заказчику по товарной группе: по ним он заполнит бриф
        в карточке клиента. Для каждого вопроса — тип ответа: <b>текст</b>, <b>один вариант</b> или <b>несколько
        вариантов</b>. «Общие вопросы» задаются любому заказчику, независимо от группы. Удалённый вопрос
        не стирается — уходит в архив вместе с уже данными на него ответами.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <input value={q} onChange={e => setQ(e.target.value)} placeholder="Поиск группы" aria-label="Поиск группы"
          className="min-w-[180px] flex-1 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-[16px] sm:max-w-xs sm:text-sm" />
        <label className="inline-flex min-h-11 cursor-pointer items-center gap-2 text-sm text-[var(--color-text)]">
          <input type="checkbox" checked={onlyFilled} onChange={e => setOnlyFilled(e.target.checked)} className="h-4 w-4 accent-[var(--color-accent)]" />
          Только с анкетой
        </label>
        <span className="text-xs text-[var(--color-text-muted)]">
          с анкетой: <b className="text-[var(--color-text)]">{filled}</b> из {list.length}
        </span>
      </div>
      {error && <p className="text-sm text-[var(--color-negative)]">{error.message}</p>}
      {isLoading && <p className="text-sm text-[var(--color-text-muted)]">Загрузка…</p>}
      {data && (
        <div className="flex flex-col gap-2">
          {shown.map(g => {
            const qs = all[g] ?? [];
            return (
              <button key={g} type="button" onClick={() => setOpen(g)}
                className={`flex min-h-11 min-w-0 items-center gap-3 rounded-xl border px-3 py-2.5 text-left hover:bg-[var(--color-bg-hover)] ${g === COMMON_GROUP ? 'border-[var(--color-accent)] bg-[var(--color-accent-soft)]' : 'border-[var(--color-border)] bg-[var(--color-bg-surface)]'}`}>
                <ClipboardList size={16} className={`shrink-0 ${qs.length ? 'text-[var(--color-accent)]' : 'text-[var(--color-text-muted)]'}`} />
                <div className="min-w-0 flex-1">
                  <div className="text-[13.5px] font-semibold text-[var(--color-text)]">{labelOf(g)}</div>
                  <div className="truncate text-[11px] text-[var(--color-text-muted)]">
                    {qs.length ? `${qs.length} ${vopros(qs.length)}: ${qs.map(x => x.question).join(' · ')}` : 'анкеты нет'}
                  </div>
                </div>
                <span className="inline-flex shrink-0 items-center gap-1 text-xs text-[var(--color-accent)]"><Pencil size={13} /> <span className="hidden sm:inline">{qs.length ? 'Изменить' : 'Создать'}</span></span>
              </button>
            );
          })}
          {shown.length === 0 && <div className="text-sm text-[var(--color-text-muted)]">Ничего не найдено.</div>}
        </div>
      )}
      {open !== null && data && (
        <QuestionnaireEditor group={open} title={labelOf(open)} initial={all[open] ?? []}
          copySources={Object.entries(all).filter(([g, l]) => g !== open && l.length).map(([g, l]) => ({ group: g, label: labelOf(g), questions: l }))}
          onClose={() => setOpen(null)}
          onSaved={saved => qc.setQueryData<Record<string, GroupQuestion[]>>(['group-questionnaires'], prev => ({ ...(prev ?? {}), [open]: saved }))} />
      )}
    </div>
  );
}
