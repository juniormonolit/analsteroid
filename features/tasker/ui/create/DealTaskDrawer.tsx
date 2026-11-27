'use client';
import { useMemo, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { CheckCircle2, ExternalLink } from 'lucide-react';
import { Drawer } from '@/components/ui/Drawer';
import { SearchSelect, type SearchSelectOption } from '@/components/ui/SearchSelect';
import { TASKER_DEAL_TOPIC_ID, type TaskerCreateResponse, type TaskerDealSnapshot } from '@/features/tasker/types';
import { createDealTasks, fetchCreators, fetchDealPreview, fetchTemplates, TaskerApiError } from './api';
import { Banner } from './CreateTaskDrawer';
import { renderTemplateBody, templateToBitrix } from '../templates/templateBody';
import { DeadlineField, mskInputToIso, quickDeadline } from '@/features/big-deals-kanban/ui/DeadlineField';
import { useStoredDraft } from '@/lib/hooks/useStoredDraft';

/**
 * Форма Задачника в режиме «Сделка» (миграция 289, TASKER_SPEC.md «Задачи по сделкам»): кнопка в строке сделки
 * дриллдауна отчёта. По задаче на сделку; исполнитель — менеджер сделки, соисполнитель — его РОП, постановщик и
 * директор — наблюдатели. Вместо цифр метрики — снимок сделки; к сроку Задачник сам проверит движение сделки.
 */
export interface DealTaskDrawerProps {
  open: boolean;
  onClose: () => void;
  dealIds: number[];
  onCreated?: (res: TaskerCreateResponse) => void;
}

export function DealTaskDrawer(props: DealTaskDrawerProps) {
  return (
    <Drawer open={props.open} onOpenChange={o => { if (!o) props.onClose(); }}
      title={props.dealIds.length > 1 ? `Задачи по сделкам (${props.dealIds.length})` : 'Задача по сделке'}
      desktopWidth="sm:max-w-[640px]" bodyClassName="p-0">
      <DealTaskForm {...props} />
    </Drawer>
  );
}

const INPUT = 'min-h-11 w-full min-w-0 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-surface)] px-3 text-base text-[var(--color-text)] outline-none focus:border-[var(--color-accent)] disabled:opacity-50 sm:text-sm';

function Field({ label, hint, children }: { label: string; hint?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <span className="text-xs font-semibold text-[var(--color-text-muted)]">{label}</span>
      {children}
      {hint && <span className="text-[11px] leading-snug text-[var(--color-text-muted)]">{hint}</span>}
    </div>
  );
}

const money = (v: number | null) => (v === null ? '—' : `${Math.round(v).toLocaleString('ru-RU')} ₽`);
const dmy = (s: string | null) => (s ? new Date(s).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: '2-digit' }) : '—');

/** Блок сделки — общий для формы и карточки задачи. */
export function DealSnapshotCard({ s, note }: { s: TaskerDealSnapshot; note?: React.ReactNode }) {
  const lost = s.stageType === 'lost';
  const won = s.stageType === 'sold' || s.stageType === 'shipped';
  return (
    <div className="flex min-w-0 flex-col gap-1.5 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-surface)] p-3">
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <a href={s.url} target="_blank" rel="noreferrer"
          className="inline-flex min-h-8 min-w-0 items-center gap-1 text-sm font-medium text-[var(--color-accent)] hover:underline">
          <span className="min-w-0 truncate">{s.title || `Сделка #${s.dealId}`}</span>
          <ExternalLink size={12} className="shrink-0" />
        </a>
        <span className="text-[11px] text-[var(--color-text-muted)]">#{s.dealId}</span>
        {note}
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Cell label="Клиент" value={s.client ?? '—'} />
        <Cell label="Сумма" value={money(s.amount)} />
        <Cell label={s.funnel ? `Стадия · ${s.funnel}` : 'Стадия'} value={s.stage ?? '—'}
          tone={lost ? 'neg' : won ? 'pos' : undefined} />
        <Cell label="Дней в стадии" value={s.daysInStage === null ? '—' : String(s.daysInStage)}
          title={s.stageSince ? `С ${dmy(s.stageSince)}${s.stageSinceSource === 'updated' ? ' — по дате изменения сделки (истории стадий нет)' : ''}` : undefined} />
      </div>
      {s.managerName && <span className="text-[11px] text-[var(--color-text-muted)]">Менеджер сделки: {s.managerName}</span>}
    </div>
  );
}

function Cell({ label, value, tone, title }: { label: string; value: string; tone?: 'neg' | 'pos'; title?: string }) {
  const color = tone === 'neg' ? 'text-[var(--color-negative)]' : tone === 'pos' ? 'text-[var(--color-positive,#16a34a)]' : 'text-[var(--color-text)]';
  return (
    <div className="min-w-0 rounded-lg bg-[var(--color-bg)] px-2 py-1.5" title={title ?? value}>
      <div className="truncate text-[10px] text-[var(--color-text-muted)]">{label}</div>
      <div className={`truncate text-sm font-semibold ${color}`}>{value}</div>
    </div>
  );
}

function DealTaskForm({ onClose, dealIds, onCreated }: DealTaskDrawerProps) {
  const previewQ = useQuery({
    queryKey: ['tasker', 'deal-preview', dealIds.join(',')],
    queryFn: () => fetchDealPreview(dealIds),
    enabled: dealIds.length > 0,
    retry: false,
  });
  const deals = useMemo(() => previewQ.data?.deals ?? [], [previewQ.data]);
  const ok = useMemo(() => deals.filter(d => d.allowed && !d.openTaskId), [deals]);
  const managerIds = useMemo(() => [...new Set(ok.map(d => d.managerId).filter((x): x is number => !!x))], [ok]);

  const creatorsQ = useQuery({
    queryKey: ['tasker', 'creators', managerIds.join(',')],
    queryFn: () => fetchCreators(managerIds),
    enabled: managerIds.length > 0,
    staleTime: 5 * 60_000,
    retry: false,
  });
  const creatorOptions = useMemo<SearchSelectOption[]>(
    () => (creatorsQ.data?.creators ?? []).map(c => ({
      value: c.role === 'self' ? '' : String(c.id),
      label: c.role === 'self' ? `${c.name} (вы)` : c.name,
      hint: c.role === 'self' ? null : c.hint,
    })),
    [creatorsQ.data],
  );

  const templatesQ = useQuery({
    queryKey: ['tasker', 'templates', TASKER_DEAL_TOPIC_ID],
    queryFn: () => fetchTemplates(TASKER_DEAL_TOPIC_ID),
    staleTime: 5 * 60_000,
  });
  const templates = useMemo(() => templatesQ.data?.templates ?? [], [templatesQ.data]);
  // Черновик (текст, шаблон, постановщик, срок) — в localStorage по сделкам: переживает закрытие шторки и
  // перезагрузку вкладки (ТЗ канбана больших 26.11, п.1). Чистится постановкой задачи.
  const [draft, setDraft, clearDraft] = useStoredDraft(`tasker-deal:${dealIds.join(',')}`,
    { extra: '', templateChoice: '', creatorId: '', deadline: quickDeadline(0) },
    d => !d.extra.trim() && !d.templateChoice && !d.creatorId);
  const { extra, templateChoice, creatorId, deadline } = draft;
  const setExtra = (v: string) => setDraft(d => ({ ...d, extra: v }));
  const setTemplateChoice = (v: string) => setDraft(d => ({ ...d, templateChoice: v }));
  const setCreatorId = (v: string) => setDraft(d => ({ ...d, creatorId: v }));
  const setDeadline = (v: string) => setDraft(d => ({ ...d, deadline: v }));
  const [templateOpen, setTemplateOpen] = useState(false);
  const template = templateChoice === 'none' ? null
    : templates.find(t => String(t.id) === templateChoice) ?? (templateChoice === '' ? templates[0] ?? null : null);
  const body = [template ? templateToBitrix(template.body) : '', extra.trim()].filter(Boolean).join('\n\n');

  // Срок — день и время по Москве, как «Назначить» в канбане больших (собрание 26.11: «сегодня через 10 минут» —
  // «и здесь нет времени»). По умолчанию «Сегодня», через час.
  const deadlineIso = mskInputToIso(deadline);
  const deadlinePast = !!deadlineIso && Date.parse(deadlineIso) < Date.now();

  const [result, setResult] = useState<TaskerCreateResponse | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const mutation = useMutation({
    mutationFn: () => createDealTasks({
      dealIds: ok.map(d => d.dealId), body, templateId: template?.id ?? null, deadline: deadlineIso ?? '',
      creatorBitrixId: creatorId ? Number(creatorId) : null,
    }),
    onMutate: () => setSubmitError(null),
    onSuccess: res => { setResult(res); if (res.created.length) { clearDraft(); onCreated?.(res); } },
    onError: (e: unknown) => setSubmitError(e instanceof TaskerApiError && e.code === 'not_configured'
      ? e.message
      : e instanceof Error ? e.message : 'Не удалось поставить задачу'),
  });

  if (result) return <DealResultView result={result} onClose={onClose} />;

  const problems: string[] = [];
  if (!ok.length) problems.push('нет сделок, по которым можно поставить задачу');
  if (!body.trim()) problems.push('напишите, что сделать');
  if (!deadline) problems.push('укажите срок');
  else if (deadlinePast) problems.push('срок уже прошёл');
  const canSubmit = problems.length === 0 && !mutation.isPending && !previewQ.isFetching;

  return (
    <div className="flex min-h-full flex-col">
      <div className="flex flex-col gap-4 p-4">
        {previewQ.isLoading && <div className="h-24 animate-pulse rounded-xl bg-[var(--color-bg-surface)]" aria-label="Загружаю сделки" />}
        {previewQ.error && <Banner tone="error">Сделки не загрузились: {(previewQ.error as Error).message}</Banner>}
        {deals.map(d => (
          <DealSnapshotCard key={d.dealId} s={d} note={
            !d.allowed ? <Tag tone="warn">менеджер не в вашей зоне — не поставим</Tag>
              : d.openTaskId ? <a href={`/tasker?task=${d.openTaskId}`} className="text-[11px] font-medium text-[var(--color-warning,#b45309)] hover:underline">уже есть открытая задача →</a>
              : null
          } />
        ))}
        {(previewQ.data?.missing.length ?? 0) > 0 && (
          <Banner tone="warn">Не найдены в базе сделок: {previewQ.data!.missing.map(id => `#${id}`).join(', ')}</Banner>
        )}

        {creatorOptions.length > 1 && (
          <Field label="Постановщик" hint={creatorId ? 'Задача — от его имени, вы останетесь в ней наблюдателем' : 'По умолчанию — вы'}>
            <SearchSelect options={creatorOptions} value={creatorId} onChange={setCreatorId}
              placeholder="Вы" ariaLabel="Постановщик" className="w-full sm:max-w-[calc(50%-8px)]" />
          </Field>
        )}

        <Field label="Что сделать" hint="Варианты текста правят в «Задачник → Шаблоны», тема «Сделки». Уходит в описание задачи вместе со снимком сделки">
          {templates.length > 0 && (
            <SearchSelect
              options={[...templates.map(t => ({ value: String(t.id), label: t.title })), { value: 'none', label: 'Без шаблона — только своё' }]}
              value={template ? String(template.id) : 'none'}
              onChange={v => { setTemplateChoice(v); setTemplateOpen(false); }}
              placeholder="Вариант текста" ariaLabel="Вариант текста" className="w-full" />
          )}
          {template && (
            <div className="min-w-0 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-hover)]/40 p-3">
              <div className={`whitespace-pre-wrap break-words text-sm leading-relaxed text-[var(--color-text)] ${templateOpen ? '' : 'line-clamp-5'}`}>
                {renderTemplateBody(template.body)}
              </div>
              {(template.body.length > 240 || template.body.split('\n').length > 5) && (
                <button type="button" onClick={() => setTemplateOpen(o => !o)} className="mt-1 min-h-8 text-xs text-[var(--color-accent)] hover:underline">
                  {templateOpen ? 'Свернуть' : 'Показать целиком'}
                </button>
              )}
            </div>
          )}
          <textarea value={extra} rows={template ? 3 : 6} onChange={e => setExtra(e.target.value)}
            aria-label={template ? 'Дописать своё' : 'Что сделать'}
            placeholder={template ? 'Дописать своё (необязательно)…' : 'Что сделать по сделке…'}
            className={`${INPUT} ${template ? 'min-h-[80px]' : 'min-h-[120px]'} resize-y py-2 leading-snug`} />
        </Field>

        <Field label="Срок" hint="К сроку Задачник сам проверит сделку: сменила стадию, продана, проиграна или без движения — итог придёт комментарием в задачу">
          <DeadlineField label="День и время" value={deadline} onChange={setDeadline} />
        </Field>

        {submitError && <Banner tone="error">{submitError}</Banner>}
      </div>

      <div className="sticky bottom-0 mt-auto flex flex-col gap-2 border-t border-[var(--color-border)] bg-[var(--color-bg-overlay)] p-4 [backdrop-filter:var(--glass-blur)] sm:flex-row sm:items-center">
        <span className="min-w-0 flex-1 text-xs text-[var(--color-text-muted)]">
          {problems.length ? `Осталось: ${problems.join(', ')}`
            : ok.length > 1 ? `Будет создано задач: ${ok.length} — по одной на сделку`
            : 'Исполнитель — менеджер сделки, соисполнитель — его РОП; задача видна в карточке сделки Битрикса'}
        </span>
        <div className="flex gap-2">
          <button type="button" onClick={onClose}
            className="min-h-11 flex-1 rounded-lg border border-[var(--color-border)] px-4 text-sm font-medium text-[var(--color-text)] hover:bg-[var(--color-bg-hover)] sm:flex-none">
            Отмена
          </button>
          <button type="button" disabled={!canSubmit} onClick={() => mutation.mutate()}
            className="min-h-11 flex-1 rounded-lg bg-[var(--color-accent)] px-4 text-sm font-semibold text-white disabled:opacity-50 sm:flex-none">
            {mutation.isPending ? 'Ставлю…' : ok.length > 1 ? `Поставить задачи (${ok.length})` : 'Поставить задачу'}
          </button>
        </div>
      </div>
    </div>
  );
}

function Tag({ tone, children }: { tone: 'warn'; children: React.ReactNode }) {
  return <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${tone === 'warn' ? 'bg-[color-mix(in_srgb,var(--color-warning,#b45309)_15%,transparent)] text-[var(--color-warning,#b45309)]' : ''}`}>{children}</span>;
}

function DealResultView({ result, onClose }: { result: TaskerCreateResponse; onClose: () => void }) {
  return (
    <div className="flex flex-col gap-4 p-4">
      {result.created.length > 0 ? (
        <div className="flex items-start gap-2.5">
          <CheckCircle2 size={22} className="shrink-0 text-[var(--color-positive,#16a34a)]" />
          <div className="min-w-0">
            <div className="text-sm font-semibold text-[var(--color-text)]">Поставлено задач: {result.created.length}</div>
            <ul className="mt-2 flex flex-col gap-1.5">
              {result.created.map(t => (
                <li key={t.id} className="flex min-w-0 flex-wrap items-center gap-x-2 text-[13px] text-[var(--color-text)]">
                  <span className="min-w-0 truncate">#{t.dealId} — {t.manager.name}</span>
                  {t.bitrixUrl ? (
                    <a href={t.bitrixUrl} target="_blank" rel="noreferrer" className="tap-target inline-flex items-center gap-1 text-[var(--color-accent)] hover:underline">
                      в Битриксе <ExternalLink size={12} />
                    </a>
                  ) : (
                    <span className="text-[11px] text-[var(--color-text-muted)]">{t.syncState === 'failed' ? `не ушла в Битрикс: ${t.syncError ?? 'ошибка'}` : 'уходит в Битрикс…'}</span>
                  )}
                </li>
              ))}
            </ul>
          </div>
        </div>
      ) : (
        <Banner tone="warn">Задачи не поставлены.</Banner>
      )}
      {result.warnings.map((w, i) => <Banner key={i} tone="warn">{w.message}</Banner>)}
      <div className="flex justify-end">
        <button type="button" onClick={onClose} className="min-h-11 rounded-lg bg-[var(--color-accent)] px-4 text-sm font-semibold text-white">Готово</button>
      </div>
    </div>
  );
}
