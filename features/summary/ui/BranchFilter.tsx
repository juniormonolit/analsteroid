'use client';

const OPTIONS = [
  { value: 'all', label: 'Россия' },
  { value: 'КРД', label: 'КРД' },
  { value: 'МСК', label: 'МСК' },
  { value: 'СПБ', label: 'СПБ' },
] as const;

export type BranchValue = (typeof OPTIONS)[number]['value'];

export function BranchFilter({ value, onChange }: { value: BranchValue; onChange: (v: BranchValue) => void }) {
  return (
    <div className="flex gap-1.5 flex-wrap" role="group" aria-label="Фильтр филиала">
      {OPTIONS.map(o => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            onClick={() => onChange(o.value)}
            aria-pressed={active}
            className={`px-3 py-1.5 rounded-full text-xs font-medium border transition-colors ${
              active
                ? 'bg-[var(--color-accent)] border-[var(--color-accent)] text-[var(--color-text-inverse)]'
                : 'bg-[var(--color-bg-surface)] border-[var(--color-border)] text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)]'
            }`}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
