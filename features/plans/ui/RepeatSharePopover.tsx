'use client';
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Popover } from '@/components/ui/Popover';

// Доля повторных продаж в плане отдела (миграция 284, app/api/plans/repeat-share).
// План продаж (повт.) = план продаж × доля — применяется к плану каждого менеджера отдела,
// поэтому сумма по отделу = план отдела × доля («МСК ОС 40 %, план 100 → 40»).
// Пустое поле = доли нет → план (повт.) не считается.

interface DeptShare {
  deptKey: string;
  branch: string;
  category: string;
  sharePct: number | null;
  updatedAt: string | null;
  updatedBy: string | null;
}

function fmtPct(v: number | null): string {
  return v === null ? '' : String(v).replace('.', ',');
}

function ShareRow({ dept, canEdit, onSaved }: { dept: DeptShare; canEdit: boolean; onSaved: () => Promise<void> }) {
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const value = draft ?? fmtPct(dept.sharePct);

  async function save() {
    if (draft === null) return;
    const raw = draft.trim().replace(',', '.').replace('%', '');
    const next = raw === '' ? null : Number(raw);
    if (next !== null && (!Number.isFinite(next) || next < 0 || next > 100)) {
      setError('0–100');
      return;
    }
    if (next === dept.sharePct) { setDraft(null); setError(null); return; }
    setSaving(true);
    const res = await fetch('/api/plans/repeat-share', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deptKey: dept.deptKey, sharePct: next }),
    });
    setSaving(false);
    if (!res.ok) {
      setError('Не сохранилось');
      return;
    }
    setError(null);
    await onSaved();
    setDraft(null);
  }

  return (
    <div className="flex items-center gap-3 px-3 py-1.5 min-h-11">
      <span className="flex-1 min-w-0 text-sm text-[var(--color-text)] truncate">
        {dept.branch} {dept.category}
      </span>
      {canEdit ? (
        <div className="flex items-center gap-1 flex-shrink-0">
          <input
            type="text"
            inputMode="decimal"
            value={value}
            placeholder="—"
            disabled={saving}
            onChange={e => { setDraft(e.target.value); setError(null); }}
            onBlur={save}
            onKeyDown={e => {
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
              if (e.key === 'Escape') { setDraft(null); setError(null); }
            }}
            aria-label={`Доля повторных продаж, ${dept.branch} ${dept.category}`}
            className={`w-16 px-2 py-1 text-base sm:text-sm text-right border rounded bg-[var(--color-bg)] text-[var(--color-text)] focus:outline-none ${
              error ? 'border-[var(--color-danger,#e53935)]' : 'border-[var(--color-border)] focus:border-[var(--color-accent)]'
            }`}
          />
          <span className="text-sm text-[var(--color-text-muted)]">%</span>
        </div>
      ) : (
        <span className="text-sm font-medium text-[var(--color-text)] flex-shrink-0">
          {dept.sharePct === null ? '—' : `${fmtPct(dept.sharePct)} %`}
        </span>
      )}
      {error && <span className="text-xs text-[var(--color-danger,#e53935)] flex-shrink-0">{error}</span>}
    </div>
  );
}

export function RepeatSharePopover({ canEdit }: { canEdit: boolean }) {
  const [open, setOpen] = useState(false);
  const qc = useQueryClient();
  const { data } = useQuery<{ departments: DeptShare[] }>({
    queryKey: ['plan-repeat-share'],
    queryFn: () => fetch('/api/plans/repeat-share').then(r => r.json()),
    staleTime: 60_000,
  });
  const depts = Array.isArray(data?.departments) ? data.departments : [];
  const setCount = depts.filter(d => d.sharePct !== null).length;

  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      align="start"
      className="w-[320px] max-w-[calc(100vw-16px)] flex flex-col overflow-hidden"
      trigger={
        <button
          className={`flex items-center gap-2 px-3 py-1.5 border rounded-lg text-sm transition-colors ${
            setCount > 0
              ? 'border-[var(--color-accent)] text-[var(--color-accent)]'
              : 'border-[var(--color-border)] hover:border-[var(--color-border-focus)] text-[var(--color-text)]'
          }`}
        >
          Доля повт.{setCount > 0 ? ` · ${setCount}` : ''}
        </button>
      }
    >
      <div className="px-3 py-2 border-b border-[var(--color-border)] flex-shrink-0">
        <div className="text-sm font-medium text-[var(--color-text)]">Доля повторных продаж в плане</div>
        <div className="text-xs text-[var(--color-text-muted)] mt-0.5">
          План продаж (повт.) = план продаж × доля отдела. Пример: доля 40 %, план 100 → план (повт.) 40.
          Пусто — плана (повт.) нет.
        </div>
      </div>
      <div className="overflow-y-auto flex-1 py-1 max-h-[360px]">
        {depts.length === 0 ? (
          <div className="px-3 py-2 text-sm text-[var(--color-text-muted)]">Загрузка…</div>
        ) : (
          depts.map(d => (
            <ShareRow
              key={d.deptKey}
              dept={d}
              canEdit={canEdit}
              onSaved={() => qc.invalidateQueries({ queryKey: ['plan-repeat-share'] })}
            />
          ))
        )}
      </div>
    </Popover>
  );
}
