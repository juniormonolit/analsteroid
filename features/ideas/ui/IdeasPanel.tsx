'use client';
import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, X } from 'lucide-react';
import { useSlideClose } from '@/lib/hooks/useSlideClose';
import { PanelCloseTab } from '@/components/ui/PanelCloseTab';
import { SlideBackdrop } from '@/components/ui/SlideBackdrop';
import { useIdeasQuery } from './useIdeasQuery';
import type { Idea, IdeaStatus } from '@/lib/ideas/types';
import { IDEA_TITLE_MAX_LEN, IDEA_BODY_MAX_LEN } from '@/lib/ideas/types';

interface Props {
  onClose: () => void;
}

const STATUS_BADGE: Record<IdeaStatus, { label: string; cls: string }> = {
  in_progress: { label: 'В работе', cls: 'bg-amber-100 text-amber-700' },
  planned: { label: 'Запланировано', cls: 'bg-[var(--color-accent-soft)] text-[var(--color-accent)]' },
  proposed: { label: 'На рассмотрении', cls: 'bg-[var(--color-bg-hover)] text-[var(--color-text-muted)]' },
  done: { label: 'Готово', cls: 'bg-green-100 text-green-700' },
  rejected: { label: 'Отклонено', cls: 'bg-[var(--color-bg-hover)] text-[var(--color-text-muted)]' },
};

// Пункты меню смены статуса для админа (п.3 задачи) — минимально, без отдельного
// экрана: нативный <select> прямо на карточке. «Предложено» (proposed) в список не
// входит — это стартовое состояние идеи, а не то, куда её возвращают вручную.
const ADMIN_STATUS_OPTIONS: { value: IdeaStatus; label: string }[] = [
  { value: 'planned', label: 'Запланировано' },
  { value: 'in_progress', label: 'В работе' },
  { value: 'done', label: 'Готово' },
  { value: 'rejected', label: 'Отклонить' },
];

/**
 * Выезжающая справа панель «Идеи и планы» (макет владельца, ideas-backlog-mock.html) —
 * построена по паттерну ChangelogPanel (features/changelog/ui/ChangelogPanel.tsx):
 * тот же SlideBackdrop + PanelCloseTab + useSlideClose, та же ширина панели.
 * Два экрана внутри одной панели: лента идей и форма подачи (стрелка назад).
 */
export function IdeasPanel({ onClose }: Props) {
  const { data } = useIdeasQuery();
  const qc = useQueryClient();
  const { closing, requestClose } = useSlideClose(onClose);
  const [view, setView] = useState<'list' | 'form'>('list');
  const [isAdmin, setIsAdmin] = useState(false);

  // Право менять статус идеи — тот же гейт, что «управление общими отчётами»
  // (action.shared_reports.manage), см. app/api/ideas/[id]/route.ts.
  useEffect(() => {
    fetch('/api/auth/session')
      .then(r => (r.ok ? r.json() : null))
      .then((d: { user?: { isSuperadmin?: boolean; permissions?: string[] } } | null) =>
        setIsAdmin(!!d?.user?.isSuperadmin || !!d?.user?.permissions?.includes('action.shared_reports.manage')))
      .catch(() => {});
  }, []);

  function changeStatus(id: string, status: IdeaStatus) {
    fetch(`/api/ideas/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status }),
    })
      .then(() => qc.invalidateQueries({ queryKey: ['ideas'] }))
      .catch(() => {});
  }

  return (
    <>
      <SlideBackdrop closing={closing} onClick={requestClose} />
      <div
        className={`fixed inset-y-0 right-0 z-50 w-full sm:w-[50vw] sm:min-w-[360px] sm:max-w-[800px] bg-[var(--color-bg-surface)] shadow-2xl flex flex-col ${closing ? 'slide-panel-out-right' : 'slide-panel-in-right'}`}
      >
        <PanelCloseTab onClick={requestClose} />

        {view === 'list' ? (
          <ListView
            data={data}
            isAdmin={isAdmin}
            onChangeStatus={changeStatus}
            onPropose={() => setView('form')}
            onCloseMobile={requestClose}
          />
        ) : (
          <FormView
            onBack={() => setView('list')}
            onSubmitted={() => {
              qc.invalidateQueries({ queryKey: ['ideas'] });
              setView('list');
            }}
            onCloseMobile={requestClose}
          />
        )}
      </div>
    </>
  );
}

function IdeaCard({ idea, isAdmin, onChangeStatus }: {
  idea: Idea;
  isAdmin: boolean;
  onChangeStatus: (id: string, status: IdeaStatus) => void;
}) {
  const badge = STATUS_BADGE[idea.status];
  return (
    <div className="px-3.5 py-3 rounded-[10px] mb-1.5 border border-[var(--color-border)]">
      <div className="flex items-start justify-between gap-2.5 mb-1">
        <div className="text-[13.5px] font-bold text-[var(--color-text)]">{idea.title}</div>
        <span className={`shrink-0 text-[10.5px] font-bold px-2.5 py-0.5 rounded-full whitespace-nowrap ${badge.cls}`}>
          {badge.label}
        </span>
      </div>
      <div className="text-[12.5px] leading-[1.45] text-[var(--color-text-muted)] mb-1.5 whitespace-pre-wrap">
        {idea.body}
      </div>
      <div className="flex items-center justify-between gap-2">
        {idea.authorName && (
          <div className="text-[11.5px] text-[var(--color-text-muted)]">предложил: {idea.authorName}</div>
        )}
        {isAdmin && (
          <select
            value=""
            onChange={e => {
              const status = e.target.value as IdeaStatus;
              if (status) onChangeStatus(idea.id, status);
            }}
            className="ml-auto text-[11px] border border-[var(--color-border)] rounded-md px-1.5 py-0.5 bg-[var(--color-bg-surface)] text-[var(--color-text-muted)]"
          >
            <option value="">Изменить статус…</option>
            {ADMIN_STATUS_OPTIONS.filter(o => o.value !== idea.status).map(o => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        )}
      </div>
    </div>
  );
}

function ListView({ data, isAdmin, onChangeStatus, onPropose, onCloseMobile }: {
  data: { planned: Idea[]; proposed: Idea[] } | undefined;
  isAdmin: boolean;
  onChangeStatus: (id: string, status: IdeaStatus) => void;
  onPropose: () => void;
  onCloseMobile: () => void;
}) {
  const planned = data?.planned ?? [];
  const proposed = data?.proposed ?? [];
  const empty = planned.length === 0 && proposed.length === 0;

  return (
    <>
      <div className="flex items-center gap-2.5 px-5 sm:px-6 py-4 border-b border-[var(--color-border)] shrink-0">
        <h2 className="text-[17px] font-bold text-[var(--color-text)] m-0">Идеи и планы</h2>
        <button
          onClick={onPropose}
          className="ml-auto text-[12.5px] font-bold text-white bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] px-3.5 py-2 rounded-lg shadow-sm shrink-0 whitespace-nowrap"
        >
          + Предложить идею
        </button>
        <button
          onClick={onCloseMobile}
          className="sm:hidden text-[var(--color-text-muted)] hover:text-[var(--color-text)] shrink-0"
        >
          <X size={18} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-2.5 py-2">
        {empty && (
          <div className="p-8 text-center text-sm text-[var(--color-text-muted)]">
            Пока нет идей — предложите первую
          </div>
        )}

        {planned.length > 0 && (
          <div>
            <div className="text-[11px] font-bold uppercase tracking-[0.04em] text-[var(--color-text-muted)] px-3 pt-3.5 pb-2">
              Запланировано
            </div>
            {planned.map(idea => (
              <IdeaCard key={idea.id} idea={idea} isAdmin={isAdmin} onChangeStatus={onChangeStatus} />
            ))}
          </div>
        )}

        {proposed.length > 0 && (
          <div>
            <div className="text-[11px] font-bold uppercase tracking-[0.04em] text-[var(--color-text-muted)] px-3 pt-3.5 pb-2">
              Предложено
            </div>
            {proposed.map(idea => (
              <IdeaCard key={idea.id} idea={idea} isAdmin={isAdmin} onChangeStatus={onChangeStatus} />
            ))}
          </div>
        )}
      </div>
    </>
  );
}

function FormView({ onBack, onSubmitted, onCloseMobile }: {
  onBack: () => void;
  onSubmitted: () => void;
  onCloseMobile: () => void;
}) {
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSubmit = title.trim().length > 0 && body.trim().length > 0 && !saving;

  async function submit() {
    if (!canSubmit) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch('/api/ideas', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: title.trim(), body: body.trim() }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error ?? 'Не удалось отправить идею');
        return;
      }
      onSubmitted();
    } catch {
      setError('Не удалось отправить идею');
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <div className="flex items-center gap-2.5 px-5 sm:px-6 py-4 border-b border-[var(--color-border)] shrink-0">
        <button onClick={onBack} className="text-[var(--color-text-muted)] hover:text-[var(--color-text)] shrink-0">
          <ArrowLeft size={18} />
        </button>
        <h2 className="text-[17px] font-bold text-[var(--color-text)] m-0">Предложить идею</h2>
        <button
          onClick={onCloseMobile}
          className="ml-auto sm:hidden text-[var(--color-text-muted)] hover:text-[var(--color-text)] shrink-0"
        >
          <X size={18} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-5 sm:px-6 py-5">
        <div className="text-xs text-[var(--color-text-muted)] leading-[1.5] mb-4 -mt-0.5">
          Расскажите, чего не хватает — админы рассмотрят и решат, брать ли идею в работу.
        </div>

        <div className="mb-4">
          <label className="block text-xs font-bold text-[var(--color-text)] mb-1.5">Название</label>
          <input
            type="text"
            value={title}
            onChange={e => setTitle(e.target.value)}
            maxLength={IDEA_TITLE_MAX_LEN}
            placeholder="Например: экспорт в Excel"
            className="w-full border border-[var(--color-border)] rounded-[9px] px-3 py-2.5 text-[13px] text-[var(--color-text)] bg-[var(--color-bg-hover)] placeholder:text-[var(--color-text-muted)]"
          />
        </div>

        <div className="mb-4">
          <label className="block text-xs font-bold text-[var(--color-text)] mb-1.5">Описание</label>
          <textarea
            value={body}
            onChange={e => setBody(e.target.value)}
            maxLength={IDEA_BODY_MAX_LEN}
            placeholder="Что именно нужно и зачем — чем подробнее, тем быстрее решим"
            className="w-full h-[110px] resize-none border border-[var(--color-border)] rounded-[9px] px-3 py-2.5 text-[13px] leading-[1.5] text-[var(--color-text)] bg-[var(--color-bg-hover)] placeholder:text-[var(--color-text-muted)]"
          />
        </div>

        {error && <div className="text-xs text-[var(--color-negative)] mb-3">{error}</div>}

        <button
          onClick={submit}
          disabled={!canSubmit}
          className="w-full bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] disabled:opacity-50 text-white text-[13.5px] font-bold py-3 rounded-[9px] shadow-sm mb-2.5"
        >
          {saving ? 'Отправляем…' : 'Отправить'}
        </button>
        <div className="text-[11.5px] text-[var(--color-text-muted)] leading-[1.5] text-center">
          Идея уйдёт админам; статус увидишь здесь же.
        </div>
      </div>
    </>
  );
}
