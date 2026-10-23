'use client';
// Заполнение анкеты товарной группы: предпросмотр в редакторе («как увидит менеджер») и анкета в карточке
// клиента (ClientQuestionnaire — поле вопроса то же, QuestionInput).
import type { GroupQuestion } from '../engine/types';

export type Answers = Record<string, string | string[]>;
export const answerKey = (q: GroupQuestion, i: number) => (q.id !== null ? String(q.id) : `new${i}`);

const field = 'w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-base sm:text-sm text-[var(--color-text)]';

/** Поле ответа по типу вопроса: текст — textarea; один вариант — радио (повторный клик снимает); несколько — галочки. */
export function QuestionInput({ q, name, value, onChange }: {
  q: Pick<GroupQuestion, 'kind' | 'options'>; name: string; value: string | string[] | undefined; onChange: (v: string | string[]) => void;
}) {
  if (q.kind === 'text') {
    return <textarea rows={2} value={typeof value === 'string' ? value : ''} onChange={e => onChange(e.target.value)} className={field} />;
  }
  const multi = q.kind === 'multi';
  return (
    <div className="flex flex-col gap-0.5">
      {q.options.map(o => {
        const checked = multi ? Array.isArray(value) && value.includes(o) : value === o;
        return (
          <label key={o} className="flex min-h-11 cursor-pointer items-center gap-2 rounded-md px-1 text-sm text-[var(--color-text)] hover:bg-[var(--color-bg-hover)]">
            <input type={multi ? 'checkbox' : 'radio'} name={name} checked={checked}
              onChange={() => {
                if (!multi) return onChange(o);
                const list = Array.isArray(value) ? value : [];
                onChange(checked ? list.filter(x => x !== o) : [...list, o]);
              }}
              onClick={() => { if (!multi && checked) onChange(''); }}
              className="h-4 w-4 shrink-0 accent-[var(--color-accent)]" />
            <span className="min-w-0">{o}</span>
          </label>
        );
      })}
    </div>
  );
}

export function QuestionnaireForm({ questions, value, onChange, disabled = false }: {
  questions: GroupQuestion[]; value: Answers; onChange: (v: Answers) => void; disabled?: boolean;
}) {
  if (!questions.length) return <p className="text-sm text-[var(--color-text-muted)]">Вопросов пока нет.</p>;
  return (
    <div className="flex flex-col gap-4">
      {questions.map((q, i) => {
        const k = answerKey(q, i);
        return (
          <fieldset key={k} className="flex min-w-0 flex-col gap-1.5" disabled={disabled}>
            <legend className="mb-1 text-sm font-semibold text-[var(--color-text)]">
              {i + 1}. {q.question}{q.required && <span className="text-[var(--color-negative)]"> *</span>}
            </legend>
            {q.hint && <p className="-mt-1 text-xs text-[var(--color-text-muted)]">{q.hint}</p>}
            <QuestionInput q={q} name={`q-${k}`} value={value[k]} onChange={v => onChange({ ...value, [k]: v })} />
          </fieldset>
        );
      })}
    </div>
  );
}
