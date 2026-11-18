'use client';
// «Вопросы и шаблоны» у чата задачи (РОП Осипов 18.11): один блок вместо двух — шаблоны РОПа (пачка вопросов
// одной кнопкой) + вопросы из описания задачи. Свои шаблоны РОП правит здесь же (TemplatesEditor, Modal).
// Хранение — users.ui_prefs.bigDealsTemplates (GET/PUT /api/big-deals-kanban/templates); на моке — только кэш.
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, AtSign, Plus, Settings2, Trash2 } from 'lucide-react';
import { Modal } from '@/components/ui/Modal';
import { DEFAULT_TEMPLATES, MAX_QUESTIONS, MAX_TEMPLATES, suggestTemplate, type BigQuestionTemplate } from '../engine/templateDefaults';

const KEY = ['big-deals-templates'];

export function useBigTemplates(mock = false) {
  return useQuery<BigQuestionTemplate[]>({
    queryKey: KEY,
    queryFn: async () => {
      if (mock) return DEFAULT_TEMPLATES;
      const r = await fetch('/api/big-deals-kanban/templates');
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error ?? `Ошибка ${r.status}`);
      return j.templates as BigQuestionTemplate[];
    },
    staleTime: 5 * 60_000,
  });
}

/** Вопросы шаблона — нумерованным списком для вставки в сообщение. */
export const templateText = (qs: string[]) => qs.map((q, i) => `${i + 1}. ${q}`).join('\n');

const chip = 'min-h-11 rounded-full border px-3 text-left text-[12px] sm:min-h-8';

export function QuestionsBlock({ questions, onInsert, mock = false, rop, deal, title = 'Вопросы и шаблоны' }: {
  /** Вопросы из описания задачи. */
  questions?: string[];
  onInsert: (text: string) => void;
  mock?: boolean;
  /** РОП исполнителя — кнопка «Отметить РОПа» (упоминание, Битрикс пришлёт ему уведомление). */
  rop?: { id: string; name: string } | null;
  /** Сделка задачи: шаблон под её стадию — первым и выделен (собрание РОПов 18.11). */
  deal?: { stageName: string; categoryId?: number | null } | null;
  title?: string;
}) {
  const t = useBigTemplates(mock);
  const [edit, setEdit] = useState(false);
  const best = t.data ? suggestTemplate(t.data, deal) : null;
  const ordered = t.data ? (best ? [best, ...t.data.filter(x => x.id !== best.id)] : t.data) : [];
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 text-[11.5px] font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">{title}</span>
        <button type="button" onClick={() => setEdit(true)} title="Свои шаблоны: создать, изменить, порядок"
          className="tap-target inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[12px] text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text)]">
          <Settings2 size={13} /> Шаблоны
        </button>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {ordered.map(tp => {
          const isBest = tp.id === best?.id;
          return (
            <button key={tp.id} type="button" onClick={() => onInsert(templateText(tp.questions))}
              title={`${isBest ? `Подходит стадии сделки «${deal?.stageName}»\n\n` : ''}${templateText(tp.questions)}`}
              className={`${chip} border-[var(--color-accent)] ${isBest ? 'bg-[var(--color-accent)] font-semibold text-white' : 'text-[var(--color-accent)] hover:bg-[var(--color-accent-soft)]'}`}>
              {isBest && <span className="mr-1 text-[10.5px] font-normal uppercase opacity-80">по стадии</span>}
              {tp.name} <span className="opacity-60 tabular-nums">· {tp.questions.length}</span>
            </button>
          );
        })}
        {rop && (
          <button type="button" onClick={() => onInsert(`[USER=${rop.id}]${rop.name}[/USER], `)} title={`Упомянуть РОПа исполнителя — ${rop.name}: Битрикс пришлёт ему уведомление`}
            className={`${chip} inline-flex items-center gap-1 border-[var(--color-border)] hover:bg-[var(--color-bg-hover)]`}>
            <AtSign size={12} /> Отметить РОПа
          </button>
        )}
        {t.isLoading && <span className="text-[12px] text-[var(--color-text-muted)]">Загружаю шаблоны…</span>}
        {t.error && <span className="text-[12px] text-[var(--color-negative)]">{(t.error as Error).message}</span>}
      </div>
      {questions && questions.length > 0 && (
        <div className="flex flex-col gap-1">
          <span className="text-[11.5px] text-[var(--color-text-muted)]">Из описания задачи:</span>
          <div className="flex flex-wrap gap-1.5">
            {questions.map((q, i) => (
              <button key={i} type="button" onClick={() => onInsert(q)}
                className={`${chip} border-[var(--color-border)] hover:bg-[var(--color-bg-hover)]`}>{q}</button>
            ))}
            {questions.length > 1 && (
              <button type="button" onClick={() => onInsert(templateText(questions))}
                className={`${chip} border-dashed border-[var(--color-border-strong)] text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)]`}>Все {questions.length}</button>
            )}
          </div>
        </div>
      )}
      {edit && t.data && <TemplatesEditor initial={t.data} mock={mock} onClose={() => setEdit(false)} />}
    </div>
  );
}

type Draft = { id: string; name: string; text: string };
const input = 'w-full min-w-0 rounded-md border border-[var(--color-border)] bg-transparent px-2.5 py-2 text-base sm:text-sm';

function TemplatesEditor({ initial, mock, onClose }: { initial: BigQuestionTemplate[]; mock: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const [list, setList] = useState<Draft[]>(() => initial.map(t => ({ id: t.id, name: t.name, text: t.questions.join('\n') })));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const set = (i: number, p: Partial<Draft>) => setList(l => l.map((x, j) => (j === i ? { ...x, ...p } : x)));
  const move = (i: number, d: -1 | 1) => setList(l => {
    const j = i + d;
    if (j < 0 || j >= l.length) return l;
    const n = [...l]; [n[i], n[j]] = [n[j], n[i]]; return n;
  });
  const save = async () => {
    const templates = list.map(x => ({ id: x.id, name: x.name, questions: x.text.split('\n').map(s => s.replace(/^\s*\d{1,2}[.)]\s*/, '').trim()).filter(Boolean) }));
    setBusy(true); setErr(null);
    try {
      if (mock) { qc.setQueryData(KEY, templates); onClose(); return; }
      const r = await fetch('/api/big-deals-kanban/templates', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ templates }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error ?? `Ошибка ${r.status}`);
      qc.setQueryData(KEY, j.templates);
      onClose();
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };

  return (
    <Modal open onOpenChange={o => { if (!o) onClose(); }} title="Мои шаблоны вопросов" desktopWidth="sm:max-w-2xl sm:w-[94vw]">
      <div className="flex min-w-0 flex-col gap-3 text-[13px]">
        <p className="text-[12.5px] text-[var(--color-text-muted)]">Шаблон — название и вопросы, по одному в строке. Кнопка шаблона вставит в сообщение все его вопросы списком. Порядок здесь — порядок кнопок. До {MAX_TEMPLATES} шаблонов, до {MAX_QUESTIONS} вопросов в каждом; шаблоны ваши, другие РОПы их не видят.</p>
        {list.length === 0 && <p className="text-[var(--color-text-muted)]">Шаблонов нет — добавьте первый.</p>}
        {list.map((x, i) => {
          const n = x.text.split('\n').filter(s => s.trim()).length;
          return (
            <div key={x.id} className="flex min-w-0 flex-col gap-2 rounded-lg border border-[var(--color-border)] p-2.5">
              <div className="flex min-w-0 items-center gap-1">
                <input value={x.name} onChange={e => set(i, { name: e.target.value })} maxLength={40} placeholder="Название, например «Первичный разбор»" aria-label="Название шаблона" className={`${input} font-semibold`} />
                <button type="button" onClick={() => move(i, -1)} disabled={i === 0} aria-label="Выше" className="tap-target rounded p-1.5 text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)] disabled:opacity-30"><ArrowUp size={15} /></button>
                <button type="button" onClick={() => move(i, 1)} disabled={i === list.length - 1} aria-label="Ниже" className="tap-target rounded p-1.5 text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)] disabled:opacity-30"><ArrowDown size={15} /></button>
                <button type="button" onClick={() => setList(l => l.filter((_, j) => j !== i))} aria-label="Удалить шаблон" className="tap-target rounded p-1.5 text-[var(--color-negative)] hover:bg-[var(--color-bg-hover)]"><Trash2 size={15} /></button>
              </div>
              <textarea value={x.text} onChange={e => set(i, { text: e.target.value })} rows={Math.min(8, Math.max(3, n + 1))} placeholder={'Когда нужен материал?\nПод какие цели?\nИНН клиента?'} aria-label="Вопросы, по одному в строке" className={input} />
              <span className={`text-[11.5px] ${n > MAX_QUESTIONS ? 'text-[var(--color-negative)]' : 'text-[var(--color-text-muted)]'}`}>Вопросов: {n}{n > MAX_QUESTIONS ? ` — больше ${MAX_QUESTIONS}` : ''}</span>
            </div>
          );
        })}
        <button type="button" disabled={list.length >= MAX_TEMPLATES} onClick={() => setList(l => [...l, { id: `n${Date.now().toString(36)}`, name: '', text: '' }])}
          className="inline-flex min-h-11 items-center justify-center gap-1 self-start rounded-md border border-dashed border-[var(--color-border-strong)] px-3 hover:bg-[var(--color-bg-hover)] disabled:opacity-50">
          <Plus size={14} /> Новый шаблон
        </button>
        {err && <p role="alert" className="text-[var(--color-negative)]">{err}</p>}
        <div className="flex flex-wrap justify-end gap-2">
          <button type="button" onClick={onClose} className="inline-flex min-h-11 items-center rounded-md border border-[var(--color-border)] px-3 hover:bg-[var(--color-bg-hover)]">Отмена</button>
          <button type="button" onClick={() => setList(DEFAULT_TEMPLATES.map(t => ({ id: t.id, name: t.name, text: t.questions.join('\n') })))}
            className="inline-flex min-h-11 items-center rounded-md px-3 text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)]">Набор РОПа (лист «Для Джуниора»)</button>
          <button type="button" disabled={busy} onClick={save} className="inline-flex min-h-11 items-center rounded-md bg-[var(--color-accent)] px-4 font-medium text-white disabled:opacity-50">{busy ? 'Сохраняю…' : 'Сохранить'}</button>
        </div>
      </div>
    </Modal>
  );
}
