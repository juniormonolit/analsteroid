'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ChevronRight, UserX } from 'lucide-react';
import { Modal } from '@/components/ui/Modal';
import { SearchSelect } from '@/components/ui/SearchSelect';
import { useCreateRun, useDismissalRuns, useDismissalUsers } from './api';
import { fmtDateTime, fmtNum } from './planMath';
import { ErrorBox, RunStatusBadge, btnPrimary, btnSecondary, card, userHint } from './shared';
import type { DismissalRunSummary } from '../types';

// «Увольнятор» (владелец 24.11): список прогонов + «Новое увольнение».

export function DismissalListPage() {
  const runs = useDismissalRuns();
  const [newOpen, setNewOpen] = useState(false);

  return (
    <div className="h-full overflow-y-auto overflow-x-hidden">
      <div className="mx-auto max-w-[1100px] p-3 pb-24 sm:p-6">
        <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
          <h1 className="text-lg font-semibold text-[var(--color-text)]">Увольнятор</h1>
          <button type="button" onClick={() => setNewOpen(true)} className={btnPrimary}>
            <UserX size={16} /> Новое увольнение
          </button>
        </div>
        <p className="mb-4 max-w-[800px] text-xs text-[var(--color-text-muted)]">
          Сотрудник уходит — здесь собирается всё, что висит на нём в Битриксе: сделки, лиды, контакты,
          компании, задачи и дела. Решаете, что передать и кому, жмёте «Готово» — дальше исполнитель
          спокойно проводит это в Битриксе по одной записи. Ответственный сделки меняется только
          бизнес-процессом «Сменить ответственного».
        </p>

        {runs.isLoading && <div className="py-10 text-center text-sm text-[var(--color-text-muted)]">Загружаю…</div>}
        {runs.isError && <ErrorBox>Не удалось загрузить список: {runs.error.message}</ErrorBox>}
        {runs.data && runs.data.length === 0 && (
          <div className={`${card} px-4 py-10 text-center text-sm text-[var(--color-text-muted)]`}>
            Увольнений ещё не было. Нажмите «Новое увольнение», чтобы выбрать сотрудника.
          </div>
        )}
        {runs.data && runs.data.length > 0 && (
          <ul className="flex flex-col gap-2">
            {runs.data.map(r => <RunRow key={r.id} run={r} />)}
          </ul>
        )}
      </div>
      <NewRunModal open={newOpen} onOpenChange={setNewOpen} />
    </div>
  );
}

function RunRow({ run }: { run: DismissalRunSummary }) {
  const c = run.counts;
  const started = run.status !== 'scanning' && run.status !== 'draft';
  return (
    <li>
      <Link href={`/dismissal/${run.id}`}
        className={`${card} flex min-h-11 items-center gap-3 px-3 py-2.5 transition-colors hover:bg-[var(--color-bg-hover)] sm:px-4`}>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="min-w-0 break-words text-sm font-semibold text-[var(--color-text)]">{run.source.name}</span>
            <RunStatusBadge status={run.status} />
            {!run.source.active && <span className="text-[11px] text-[var(--color-text-muted)]">уволен в Битриксе</span>}
          </div>
          <div className="mt-0.5 text-xs text-[var(--color-text-muted)] break-words">
            {fmtDateTime(run.createdAt)} · {run.createdByName}
            {userHint(run.source) && <> · {userHint(run.source)}</>}
          </div>
          {run.error && <div className="mt-0.5 text-xs text-[var(--color-negative)] break-words">{run.error}</div>}
        </div>
        <div className="flex shrink-0 flex-col items-end gap-0.5 text-xs tabular-nums text-[var(--color-text-muted)] sm:flex-row sm:gap-3">
          {started ? (
            <>
              <span>сделано <b className="text-[var(--color-text)]">{fmtNum(c.done)}</b></span>
              {c.error > 0 && <span className="text-[var(--color-negative)]">ошибок <b>{fmtNum(c.error)}</b></span>}
              <span>из <b className="text-[var(--color-text)]">{fmtNum(c.total)}</b></span>
            </>
          ) : run.status === 'draft' ? (
            <span>всего <b className="text-[var(--color-text)]">{fmtNum(c.total)}</b></span>
          ) : null}
        </div>
        <ChevronRight size={16} className="shrink-0 text-[var(--color-text-muted)]" />
      </Link>
    </li>
  );
}

function NewRunModal({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const router = useRouter();
  const users = useDismissalUsers();
  const create = useCreateRun();
  const [picked, setPicked] = useState('');

  // Уволенные (неактивные в Битриксе) — первыми: обычно увольняют того, кого уже отключили.
  const options = useMemo(() => (users.data ?? [])
    .slice()
    .sort((a, b) => Number(a.active) - Number(b.active) || a.name.localeCompare(b.name, 'ru'))
    .map(u => ({
      value: String(u.bitrixId),
      label: u.active ? u.name : `${u.name} · уволен`,
      hint: userHint(u),
      group: u.active ? 'Работают' : 'Уволены в Битриксе',
    })), [users.data]);

  const submit = () => {
    const id = Number(picked);
    if (!id) return;
    create.mutate(id, { onSuccess: r => router.push(`/dismissal/${r.id}`) });
  };

  return (
    <Modal open={open} onOpenChange={o => { onOpenChange(o); if (!o) { setPicked(''); create.reset(); } }}
      title="Новое увольнение" desktopWidth="sm:max-w-md">
      <div className="flex flex-col gap-3">
        <p className="text-sm text-[var(--color-text-muted)]">
          Выберите сотрудника — соберу всё, что на нём в Битриксе. Ничего не меняется, пока вы не нажмёте «Готово» на следующем шаге.
        </p>
        {users.isError ? (
          <ErrorBox>Не удалось загрузить сотрудников: {users.error.message}</ErrorBox>
        ) : (
          <SearchSelect
            options={options}
            value={picked}
            onChange={setPicked}
            searchable
            placeholder={users.isLoading ? 'Загружаю сотрудников…' : 'Кого увольняем?'}
            searchPlaceholder="Имя, должность, отдел…"
            disabled={users.isLoading}
            ariaLabel="Сотрудник"
            className="w-full"
            panelClassName="w-[400px] max-w-[calc(100vw-16px)]"
          />
        )}
        {create.isError && <ErrorBox>{create.error.message}</ErrorBox>}
        <div className="mt-2 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <button type="button" className={btnSecondary} onClick={() => onOpenChange(false)}>Отмена</button>
          <button type="button" className={btnPrimary} disabled={!picked || create.isPending || create.isSuccess} onClick={submit}>
            {create.isPending || create.isSuccess ? 'Создаю…' : 'Собрать'}
          </button>
        </div>
      </div>
    </Modal>
  );
}
