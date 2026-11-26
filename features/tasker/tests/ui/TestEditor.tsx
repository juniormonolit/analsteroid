'use client';
import { useRef, useState } from 'react';
import { ArrowDown, ArrowUp, ImagePlus, Plus, Trash2, X } from 'lucide-react';
import { SearchSelect } from '@/components/ui/SearchSelect';
import type { TaskerMetric } from '../../types';
import type { TestFull, TestQuestion, TestSaveRequest, TestSettings } from '../types';
import { uploadTestImage } from './api';
import { BTN, BTN_PRIMARY, INPUT } from './format';

const newId = () => Math.random().toString(36).slice(2, 10);
const blankQuestion = (): TestQuestion => ({
  id: newId(), kind: 'single', text: '', imageUrl: null, explanation: '',
  options: [{ id: newId(), text: '', correct: true }, { id: newId(), text: '', correct: false }],
});

/**
 * Редактор теста (тренер): настройки + вопросы. «Сохранить» пишет рабочую копию; «Опубликовать» — снимок-версию
 * (по старой версии уже проходили — появится новая, старые результаты остаются на своей).
 */
export function TestEditor({ test, metrics, busy, error, onSave }: {
  test: TestFull;
  metrics: TaskerMetric[];
  busy: boolean;
  error: string | null;
  onSave: (req: TestSaveRequest) => void;
}) {
  const [s, setS] = useState<TestSettings>({
    title: test.title, description: test.description, metricId: test.metricId, passPercent: test.passPercent,
    timeLimitMin: test.timeLimitMin, shuffleQuestions: test.shuffleQuestions, shuffleOptions: test.shuffleOptions,
    isCertification: test.isCertification,
  });
  const [qs, setQs] = useState<TestQuestion[]>(test.questions.length ? test.questions : [blankQuestion()]);
  const [uploadErr, setUploadErr] = useState<string | null>(null);
  const metricOptions = [{ value: '', label: 'Без темы' }, ...metrics.filter(m => m.active !== false && m.kind !== 'deal').map(m => ({ value: m.id, label: m.label }))];

  const upd = (i: number, patch: Partial<TestQuestion>) => setQs(list => list.map((q, j) => (j === i ? { ...q, ...patch } : q)));
  const move = (i: number, d: -1 | 1) => setQs(list => {
    const x = [...list]; const j = i + d;
    if (j < 0 || j >= x.length) return list;
    [x[i], x[j]] = [x[j], x[i]]; return x;
  });
  const payload = (): TestSaveRequest => ({ ...s, questions: qs });
  const archived = test.status === 'archived';

  return (
    <div className="flex min-w-0 flex-col gap-4 text-sm">
      <section className="flex min-w-0 flex-col gap-3">
        <label className="flex min-w-0 flex-col gap-1">
          <span className="text-[12.5px] text-[var(--color-text-secondary)]">Название</span>
          <input value={s.title} maxLength={200} onChange={e => setS({ ...s, title: e.target.value })} className={INPUT} placeholder="Например: Кровля — материалы и монтаж" />
        </label>
        <label className="flex min-w-0 flex-col gap-1">
          <span className="text-[12.5px] text-[var(--color-text-secondary)]">Описание для менеджера</span>
          <textarea value={s.description} maxLength={4000} rows={2} onChange={e => setS({ ...s, description: e.target.value })}
            className={`${INPUT} py-2`} placeholder="О чём тест, по какому обучению" />
        </label>
        <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-3">
          <label className="flex min-w-0 flex-col gap-1 sm:col-span-1">
            <span className="text-[12.5px] text-[var(--color-text-secondary)]">Тема</span>
            <SearchSelect options={metricOptions} value={s.metricId ?? ''} onChange={v => setS({ ...s, metricId: v || null })} searchable
              ariaLabel="Тема теста" className="min-h-11 w-full min-w-0" />
          </label>
          <label className="flex min-w-0 flex-col gap-1">
            <span className="text-[12.5px] text-[var(--color-text-secondary)]">Проходной балл, %</span>
            <input type="number" min={1} max={100} inputMode="numeric" value={s.passPercent}
              onChange={e => setS({ ...s, passPercent: Number(e.target.value) || 0 })} className={INPUT} />
          </label>
          <label className="flex min-w-0 flex-col gap-1">
            <span className="text-[12.5px] text-[var(--color-text-secondary)]">Лимит времени, мин</span>
            <input type="number" min={0} max={240} inputMode="numeric" value={s.timeLimitMin ?? ''} placeholder="без лимита"
              onChange={e => setS({ ...s, timeLimitMin: e.target.value ? Number(e.target.value) : null })} className={INPUT} />
          </label>
        </div>
        <div className="flex min-w-0 flex-wrap gap-x-5 gap-y-1">
          {([['shuffleQuestions', 'Перемешивать вопросы'], ['shuffleOptions', 'Перемешивать варианты'], ['isCertification', 'Аттестационный (для грейдов)']] as const).map(([k, label]) => (
            <label key={k} className="inline-flex min-h-11 items-center gap-2">
              <input type="checkbox" checked={s[k]} onChange={e => setS({ ...s, [k]: e.target.checked })} className="size-4 accent-[var(--color-accent)]" />
              {label}
            </label>
          ))}
        </div>
      </section>

      <section className="flex min-w-0 flex-col gap-3">
        <h3 className="text-[15px] font-semibold">Вопросы · {qs.length}</h3>
        {qs.map((q, i) => (
          <QuestionCard key={q.id} q={q} n={i + 1} total={qs.length}
            onChange={p => upd(i, p)} onMove={d => move(i, d)} onRemove={() => setQs(list => list.filter((_, j) => j !== i))}
            onUploadError={setUploadErr} />
        ))}
        <button type="button" onClick={() => setQs(list => [...list, blankQuestion()])} className={`${BTN} self-start`}>
          <Plus size={16} aria-hidden /> Добавить вопрос
        </button>
        {uploadErr && <p className="text-[var(--color-negative)]">{uploadErr}</p>}
      </section>

      {error && <p className="rounded-lg border border-[var(--color-negative)] px-3 py-2 text-[var(--color-negative)]">{error}</p>}
      {test.version != null && (
        <p className="text-[12.5px] text-[var(--color-text-muted)]">
          Опубликована версия {test.version}. Если по ней уже проходили, публикация правок создаст новую версию — прежние результаты останутся на своей.
        </p>
      )}
      <div className="sticky bottom-0 -mx-1 flex min-w-0 flex-wrap gap-2 border-t border-[var(--color-border)] bg-[var(--color-bg-surface,var(--color-bg))] px-1 py-3">
        <button type="button" disabled={busy} onClick={() => onSave(payload())} className={BTN}>Сохранить</button>
        {!archived && (
          <button type="button" disabled={busy} onClick={() => onSave({ ...payload(), action: 'publish' })} className={BTN_PRIMARY}>
            {test.status === 'published' ? 'Опубликовать правки' : 'Опубликовать'}
          </button>
        )}
        {archived
          ? <button type="button" disabled={busy} onClick={() => onSave({ action: 'unarchive' })} className={BTN}>Вернуть из архива</button>
          : <button type="button" disabled={busy} onClick={() => onSave({ action: 'archive' })} className={`${BTN} sm:ml-auto text-[var(--color-text-secondary)]`}>В архив</button>}
      </div>
    </div>
  );
}

function QuestionCard({ q, n, total, onChange, onMove, onRemove, onUploadError }: {
  q: TestQuestion; n: number; total: number;
  onChange: (p: Partial<TestQuestion>) => void;
  onMove: (d: -1 | 1) => void;
  onRemove: () => void;
  onUploadError: (e: string | null) => void;
}) {
  const file = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const setOpt = (id: string, patch: Partial<TestQuestion['options'][number]>) =>
    onChange({ options: q.options.map(o => (o.id === id ? { ...o, ...patch } : o)) });
  const markCorrect = (id: string, on: boolean) =>
    onChange({ options: q.options.map(o => (o.id === id ? { ...o, correct: on } : q.kind === 'single' && on ? { ...o, correct: false } : o)) });
  const onFile = async (f: File | undefined) => {
    if (!f) return;
    setUploading(true); onUploadError(null);
    try { onChange({ imageUrl: (await uploadTestImage(f)).url }); } catch (e) { onUploadError((e as Error).message); }
    finally { setUploading(false); if (file.current) file.current.value = ''; }
  };

  return (
    <div className="flex min-w-0 flex-col gap-2 rounded-xl border border-[var(--color-border)] p-3">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <b className="shrink-0">#{n}</b>
        <div className="inline-flex rounded-lg border border-[var(--color-border)] p-0.5" role="group" aria-label="Тип вопроса">
          {(['single', 'multi'] as const).map(k => (
            <button key={k} type="button" aria-pressed={q.kind === k}
              onClick={() => onChange({ kind: k, options: k === 'single' ? q.options.map((o, i) => ({ ...o, correct: i === q.options.findIndex(x => x.correct) })) : q.options })}
              className={`min-h-10 rounded-md px-2.5 text-[13px] ${q.kind === k ? 'bg-[var(--color-accent)] text-white' : 'hover:bg-[var(--color-bg-hover)]'}`}>
              {k === 'single' ? 'Один ответ' : 'Несколько'}
            </button>
          ))}
        </div>
        <span className="ml-auto inline-flex items-center gap-1">
          <button type="button" aria-label="Выше" disabled={n === 1} onClick={() => onMove(-1)} className="tap-target inline-flex size-9 items-center justify-center rounded-md hover:bg-[var(--color-bg-hover)] disabled:opacity-30"><ArrowUp size={16} /></button>
          <button type="button" aria-label="Ниже" disabled={n === total} onClick={() => onMove(1)} className="tap-target inline-flex size-9 items-center justify-center rounded-md hover:bg-[var(--color-bg-hover)] disabled:opacity-30"><ArrowDown size={16} /></button>
          <button type="button" aria-label="Удалить вопрос" onClick={onRemove} className="tap-target inline-flex size-9 items-center justify-center rounded-md text-[var(--color-negative)] hover:bg-[var(--color-bg-hover)]"><Trash2 size={16} /></button>
        </span>
      </div>
      <textarea value={q.text} maxLength={2000} rows={2} onChange={e => onChange({ text: e.target.value })} placeholder="Текст вопроса"
        className={`${INPUT} py-2`} />
      {q.imageUrl ? (
        <div className="relative w-fit max-w-full">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={q.imageUrl} alt="" className="max-h-48 max-w-full rounded-lg border border-[var(--color-border)]" />
          <button type="button" aria-label="Убрать картинку" onClick={() => onChange({ imageUrl: null })}
            className="tap-target absolute right-1 top-1 inline-flex size-8 items-center justify-center rounded-full bg-black/60 text-white"><X size={14} /></button>
        </div>
      ) : (
        <button type="button" onClick={() => file.current?.click()} disabled={uploading} className={`${BTN} self-start`}>
          <ImagePlus size={16} aria-hidden /> {uploading ? 'Загружаю…' : 'Картинка'}
        </button>
      )}
      <input ref={file} type="file" accept="image/png,image/jpeg,image/webp,image/gif" className="hidden" onChange={e => onFile(e.target.files?.[0])} />

      <div className="flex min-w-0 flex-col gap-1.5">
        <span className="text-[12px] text-[var(--color-text-muted)]">Варианты — отметьте {q.kind === 'single' ? 'правильный' : 'все правильные'}</span>
        {q.options.map((o, i) => (
          <div key={o.id} className="flex min-w-0 items-center gap-2">
            <input type={q.kind === 'single' ? 'radio' : 'checkbox'} name={`q-${q.id}`} checked={o.correct} aria-label={`Вариант ${i + 1} правильный`}
              onChange={e => markCorrect(o.id, e.target.checked)} className="size-5 shrink-0 accent-[var(--color-positive)]" />
            <input value={o.text} maxLength={500} onChange={e => setOpt(o.id, { text: e.target.value })} placeholder={`Вариант ${i + 1}`} className={INPUT} />
            <button type="button" aria-label="Удалить вариант" disabled={q.options.length <= 2}
              onClick={() => onChange({ options: q.options.filter(x => x.id !== o.id) })}
              className="tap-target inline-flex size-9 shrink-0 items-center justify-center rounded-md text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)] disabled:opacity-30"><Trash2 size={15} /></button>
          </div>
        ))}
        {q.options.length < 10 && (
          <button type="button" onClick={() => onChange({ options: [...q.options, { id: newId(), text: '', correct: false }] })}
            className="inline-flex min-h-11 w-fit items-center gap-1 text-[13px] text-[var(--color-accent)] hover:underline">
            <Plus size={14} aria-hidden /> вариант
          </button>
        )}
      </div>
      <textarea value={q.explanation} maxLength={2000} rows={1} onChange={e => onChange({ explanation: e.target.value })}
        placeholder="Пояснение к правильному ответу (видит только тренер)" className={`${INPUT} py-2`} />
    </div>
  );
}
