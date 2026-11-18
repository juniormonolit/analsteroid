'use client';

// Карточка сотрудника на логине (таймлайн «Сотрудники», решение владельца 18.11):
// кто сидел на логине с–по, правка ФИО / должности / даты найма / даты увольнения,
// добавление человека (в т.ч. из карточки смарт-процесса 1054 «Сотрудники Монолит»),
// ссылка на профиль (ЛК). Править — админ или право «Сотрудники: редактирование».

import { useState } from 'react';
import Link from 'next/link';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Pencil, Plus, Trash2, UserRound } from 'lucide-react';
import { Modal } from '@/components/ui/Modal';
import { SearchSelect } from '@/components/ui/SearchSelect';
import { tenureLabel } from '@/features/employees/engine/tenure';

export interface TenureDto {
  id: number; bitrixId: number; personName: string; startDate: string | null; endDate: string | null;
  position: string | null; hrItemId: number | null; source: 'snapshot' | 'rename' | 'manual' | 'hr_card';
  updatedBy: string | null; updatedAt: string | null;
}
interface HrCardDto {
  itemId: number; title: string; stageName: string | null; isEmployed: boolean;
  hiredDate: string | null; cardCreated: string; firedDate: string | null; position: string | null;
}
export interface LoginDto {
  bitrixId: number; name: string; login: string | null; department: string | null; branch: string | null; isActive: boolean;
}

const SOURCE_LABEL: Record<TenureDto['source'], string> = {
  snapshot: 'зафиксирован 18.11', rename: 'смена имени в Битриксе', manual: 'добавлен вручную', hr_card: 'из карточки Битрикса',
};
const HR_PORTAL = 'https://td.monolit-crm.ru/crm/type/1054/details/';

export function fmtDate(iso: string | null): string {
  if (!iso) return '';
  const [y, m, d] = iso.split('-');
  return `${d}.${m}.${y}`;
}

interface Draft { personName: string; position: string; startDate: string; endDate: string; hrItemId: number | null }
const emptyDraft: Draft = { personName: '', position: '', startDate: '', endDate: '', hrItemId: null };

const inputCls = 'w-full rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1.5 text-base sm:text-sm';
const btnCls = 'min-h-11 sm:min-h-9 rounded-lg px-3 text-sm font-semibold';

export function TenureCardModal({ login, onClose }: { login: LoginDto | null; onClose: () => void }) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState<number | 'new' | null>(null);
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const { data, isLoading } = useQuery<{ tenures: TenureDto[]; hrCards: HrCardDto[]; canEdit: boolean }>({
    queryKey: ['employee-tenure', login?.bitrixId],
    enabled: !!login,
    queryFn: async () => {
      const res = await fetch(`/api/employees/tenure?bitrixId=${login!.bitrixId}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
  });
  const canEdit = data?.canEdit ?? false;
  const tenures = [...(data?.tenures ?? [])].sort((a, b) =>
    (b.endDate ?? '9999').localeCompare(a.endDate ?? '9999') || (b.startDate ?? '').localeCompare(a.startDate ?? ''));

  const close = () => { setEditing(null); setError(null); onClose(); };
  const startEdit = (t: TenureDto) => {
    setEditing(t.id); setError(null);
    setDraft({ personName: t.personName, position: t.position ?? '', startDate: t.startDate ?? '', endDate: t.endDate ?? '', hrItemId: t.hrItemId });
  };
  const startNew = () => { setEditing('new'); setError(null); setDraft(emptyDraft); };
  const pickHr = (itemId: string) => {
    const c = data?.hrCards.find(x => String(x.itemId) === itemId);
    if (!c) { setDraft(d => ({ ...d, hrItemId: null })); return; }
    setDraft({
      personName: c.title, position: c.position ?? '', hrItemId: c.itemId,
      startDate: c.hiredDate ?? c.cardCreated, endDate: c.isEmployed ? '' : (c.firedDate ?? ''),
    });
  };

  const send = async (body: Record<string, unknown>) => {
    setSaving(true); setError(null);
    const res = await fetch('/api/employees/tenure', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    setSaving(false);
    if (!res.ok) {
      const b = await res.json().catch(() => null);
      setError(b?.error ?? `Ошибка ${res.status}`);
      return false;
    }
    await Promise.all([
      qc.invalidateQueries({ queryKey: ['employee-tenure', login?.bitrixId] }),
      qc.invalidateQueries({ queryKey: ['employees-timeline'] }),
      qc.invalidateQueries({ queryKey: ['employees'] }),
    ]);
    setEditing(null);
    return true;
  };

  const save = () => send({
    op: editing === 'new' ? 'create' : 'update',
    ...(editing === 'new' ? { bitrixId: login!.bitrixId, hrItemId: draft.hrItemId } : { id: editing }),
    personName: draft.personName, position: draft.position,
    startDate: draft.startDate || null, endDate: draft.endDate || null,
  });
  const remove = (t: TenureDto) => {
    if (!window.confirm(`Удалить период «${t.personName}» с логина? Это не увольнение — запись исчезнет из истории.`)) return;
    void send({ op: 'delete', id: t.id });
  };

  const form = (
    <div className="mt-2 grid grid-cols-1 gap-2 rounded-lg border border-[var(--color-border)] p-3 sm:grid-cols-2">
      {editing === 'new' && (data?.hrCards.length ?? 0) > 0 && (
        <label className="sm:col-span-2 text-xs text-[var(--color-text-muted)]">
          Взять из карточки «Сотрудники Монолит»
          <SearchSelect
            options={data!.hrCards.map(c => ({
              value: String(c.itemId), label: c.title,
              hint: [c.stageName, c.isEmployed ? `с ${fmtDate(c.hiredDate ?? c.cardCreated)}` : `уволен ${fmtDate(c.firedDate)}`].filter(Boolean).join(' · '),
            }))}
            value={draft.hrItemId ? String(draft.hrItemId) : ''}
            onChange={pickHr}
            allLabel="— не из карточки —"
            searchable
            className="mt-1 w-full"
            ariaLabel="Карточка Битрикса"
          />
        </label>
      )}
      <label className="text-xs text-[var(--color-text-muted)]">ФИО
        <input className={inputCls} value={draft.personName} onChange={e => setDraft(d => ({ ...d, personName: e.target.value }))} />
      </label>
      <label className="text-xs text-[var(--color-text-muted)]">Должность
        <input className={inputCls} value={draft.position} onChange={e => setDraft(d => ({ ...d, position: e.target.value }))} />
      </label>
      <label className="text-xs text-[var(--color-text-muted)]">Дата найма
        <input type="date" className={inputCls} value={draft.startDate} onChange={e => setDraft(d => ({ ...d, startDate: e.target.value }))} />
      </label>
      <label className="text-xs text-[var(--color-text-muted)]">Дата увольнения <span className="opacity-70">(пусто — работает)</span>
        <input type="date" className={inputCls} value={draft.endDate} onChange={e => setDraft(d => ({ ...d, endDate: e.target.value }))} />
      </label>
      {error && <div className="sm:col-span-2 text-sm text-red-500">{error}</div>}
      <div className="sm:col-span-2 flex flex-wrap gap-2">
        <button type="button" disabled={saving} onClick={() => void save()}
          className={`${btnCls} bg-[var(--color-accent)] text-[var(--color-text-inverse)] disabled:opacity-50`}>
          {saving ? 'Сохранение…' : 'Сохранить'}
        </button>
        <button type="button" disabled={saving} onClick={() => { setEditing(null); setError(null); }}
          className={`${btnCls} border border-[var(--color-border)]`}>Отмена</button>
      </div>
    </div>
  );

  return (
    <Modal
      open={!!login}
      onOpenChange={(o) => { if (!o) close(); }}
      desktopWidth="sm:max-w-[560px] sm:w-full"
      title={login ? (
        <span className="flex flex-col">
          <span>{login.name}</span>
          <span className="text-xs font-normal text-[var(--color-text-muted)]">
            Логин {login.login ?? '—'} · ID {login.bitrixId}{login.department ? ` · ${login.department}` : ''}{login.isActive ? '' : ' · отключён в Битриксе'}
          </span>
        </span>
      ) : null}
    >
      {login && (
        <div className="flex flex-col gap-3 text-sm">
          <Link
            href={`/manager/${login.bitrixId}?view=readonly&name=${encodeURIComponent(login.name)}`}
            className={`${btnCls} inline-flex w-fit items-center gap-1.5 border border-[var(--color-border)] text-[var(--color-accent)] hover:bg-[var(--color-bg-hover)]`}
          >
            <UserRound size={14} /> Открыть профиль
          </Link>

          <div className="flex items-center justify-between gap-2">
            <h3 className="text-xs font-semibold uppercase text-[var(--color-text-muted)]">Кто был на логине</h3>
            {canEdit && editing === null && (
              <button type="button" onClick={startNew}
                className={`${btnCls} inline-flex items-center gap-1 text-[var(--color-accent)] hover:bg-[var(--color-bg-hover)]`}>
                <Plus size={14} /> Добавить человека
              </button>
            )}
          </div>

          {editing === 'new' && form}
          {isLoading && <div className="text-[var(--color-text-muted)]">Загрузка…</div>}
          {!isLoading && tenures.length === 0 && editing !== 'new' && (
            <div className="text-[var(--color-text-muted)]">Периодов пока нет — фиксация пройдёт при ночной синхронизации.</div>
          )}

          <ul className="flex flex-col gap-2">
            {tenures.map(t => (
              <li key={t.id} className="rounded-lg border border-[var(--color-border)] p-3">
                {editing === t.id ? form : (
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="font-semibold">
                        {t.personName}
                        {t.endDate === null && <span className="ml-2 rounded bg-[color-mix(in_srgb,var(--color-accent)_12%,transparent)] px-1.5 py-px text-[11px] text-[var(--color-accent)]">сейчас</span>}
                      </div>
                      {t.position && <div className="text-xs text-[var(--color-text-muted)]">{t.position}</div>}
                      <div className="mt-1 tabular-nums">
                        {t.startDate ? fmtDate(t.startDate) : <span className="text-amber-600">дата найма не указана</span>}
                        {' — '}
                        {t.endDate ? fmtDate(t.endDate) : 'работает'}
                        {t.startDate && <span className="ml-2 text-xs text-[var(--color-text-muted)]">
                          {tenureLabel(t.startDate, t.endDate ? new Date(`${t.endDate}T12:00:00Z`) : undefined)}
                        </span>}
                      </div>
                      <div className="mt-1 text-[11px] text-[var(--color-text-muted)]">
                        {SOURCE_LABEL[t.source]}
                        {t.hrItemId && <> · <a href={`${HR_PORTAL}${t.hrItemId}/`} target="_blank" rel="noreferrer" className="underline">карточка в Битриксе</a></>}
                        {t.updatedBy && t.updatedBy !== 'org-sync' && <> · правил {t.updatedBy} {t.updatedAt}</>}
                      </div>
                    </div>
                    {canEdit && editing === null && (
                      <div className="flex shrink-0 gap-1">
                        <button type="button" onClick={() => startEdit(t)} title="Изменить"
                          className="tap-target rounded p-1.5 text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)]"><Pencil size={14} /></button>
                        <button type="button" onClick={() => remove(t)} title="Удалить период"
                          className="tap-target rounded p-1.5 text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)]"><Trash2 size={14} /></button>
                      </div>
                    )}
                  </div>
                )}
              </li>
            ))}
          </ul>
          {error && editing === null && <div className="text-sm text-red-500">{error}</div>}
        </div>
      )}
    </Modal>
  );
}
