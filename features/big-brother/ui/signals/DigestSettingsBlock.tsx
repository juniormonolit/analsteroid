'use client';
// Еженедельный дайджест директору (бот «Аналитик», функция big_brother_digest): вкл/выкл, режим (предпросмотр — только
// одному человеку / получателям), получатели, час понедельника. Менять — только администраторы; посмотреть текст и
// «отправить мне» — любой, кому открыт раздел.
import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { SearchSelect, type SearchSelectOption } from '@/components/ui/SearchSelect';
import { SearchMultiSelect } from '@/components/ui/SearchMultiSelect';
import type { DigestSettings } from '../../engine/signals/types';
import { CARD } from '../people/shared';

type SettingsDto = DigestSettings & { installed: boolean; canEdit: boolean; candidates: SearchSelectOption[] };

const MODE_OPTS = [
  { value: 'preview', label: 'Предпросмотр — только одному' },
  { value: 'live', label: 'Рассылка получателям' },
];
const HOUR_OPTS = Array.from({ length: 9 }, (_, i) => ({ value: String(i + 6), label: `${i + 6}:00 МСК` }));

async function json<T>(r: Response): Promise<T> {
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error ?? `Ошибка ${r.status}`);
  return j as T;
}

export function DigestSettingsBlock() {
  const qc = useQueryClient();
  const { data, error } = useQuery<SettingsDto, Error>({
    queryKey: ['big-brother-digest-settings'],
    queryFn: () => fetch('/api/big-brother/signals/settings').then(r => json<SettingsDto>(r)),
  });
  const [draft, setDraft] = useState<DigestSettings | null>(null);
  useEffect(() => { if (data) setDraft({ enabled: data.enabled, mode: data.mode, recipients: data.recipients, previewTo: data.previewTo, hour: data.hour }); }, [data]);

  const save = useMutation<DigestSettings, Error, DigestSettings>({
    mutationFn: body => fetch('/api/big-brother/signals/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(r => json<DigestSettings>(r)),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['big-brother-digest-settings'] }),
  });
  const digest = useMutation<{ sent: boolean; text: string; week: { from: string; to: string } }, Error, 'preview' | 'send_me'>({
    mutationFn: action => fetch('/api/big-brother/signals/digest', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action }) }).then(r => json(r)),
  });

  const ro = !data?.canEdit || !data.installed;
  const dirty = !!data && !!draft && JSON.stringify(draft) !== JSON.stringify({ enabled: data.enabled, mode: data.mode, recipients: data.recipients, previewTo: data.previewTo, hour: data.hour });
  const btn = 'inline-flex min-h-11 items-center rounded-lg px-3 text-sm disabled:opacity-50';

  return (
    <section className={`${CARD} flex min-w-0 flex-col gap-3 p-3`}>
      <h2 className="text-sm font-semibold text-[var(--color-text)]">Еженедельный дайджест директору</h2>
      <p className="text-xs text-[var(--color-text-muted)]">
        Понедельник утром ботом «Аналитик», только отклонения за прошлую неделю, до 10 строк: кто перестал выходить на связь,
        РОПы без задач, топ и антитоп отчётов, новые сигналы. Каждому — по его срезу. Сотрудникам ничего не отправляется.
      </p>
      {error && <p className="text-sm text-[var(--color-negative)]">{error.message}</p>}
      {data && !data.installed && <p className="text-sm text-[var(--color-negative)]">Функция ещё не заведена в базе (миграция 298) — настройки появятся после выкатки.</p>}
      {data && draft && (
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <label className="flex min-h-11 items-center gap-2 text-sm text-[var(--color-text)]">
            <input type="checkbox" className="h-5 w-5" checked={draft.enabled} disabled={ro}
              onChange={e => setDraft({ ...draft, enabled: e.target.checked })} />
            Включён
          </label>
          <SearchSelect ariaLabel="Режим" options={MODE_OPTS} value={draft.mode} disabled={ro}
            onChange={v => setDraft({ ...draft, mode: v === 'live' ? 'live' : 'preview' })} className="min-h-11 max-w-full" />
          {draft.mode === 'preview' ? (
            <SearchSelect ariaLabel="Кому предпросмотр" options={data.candidates} value={draft.previewTo} disabled={ro} searchable
              onChange={v => setDraft({ ...draft, previewTo: v })} placeholder="Кому предпросмотр" className="min-h-11 max-w-full" />
          ) : (
            <SearchMultiSelect ariaLabel="Получатели" options={data.candidates} value={draft.recipients}
              onChange={v => !ro && setDraft({ ...draft, recipients: v })} allLabel="Получатели не выбраны" className="min-h-11 max-w-full" />
          )}
          <SearchSelect ariaLabel="Час отправки" options={HOUR_OPTS} value={String(draft.hour)} disabled={ro}
            onChange={v => setDraft({ ...draft, hour: Number(v) })} className="min-h-11 max-w-full" />
        </div>
      )}
      <div className="flex min-w-0 flex-wrap gap-2">
        {data?.canEdit && (
          <button type="button" disabled={!dirty || save.isPending} onClick={() => draft && save.mutate(draft)}
            className={`${btn} bg-[var(--color-accent)] text-white`}>{save.isPending ? 'Сохраняю…' : 'Сохранить'}</button>
        )}
        <button type="button" disabled={digest.isPending} onClick={() => digest.mutate('preview')}
          className={`${btn} border border-[var(--color-border)] text-[var(--color-text)] hover:bg-[var(--color-bg-hover)]`}>Показать текст</button>
        <button type="button" disabled={digest.isPending} onClick={() => digest.mutate('send_me')}
          className={`${btn} border border-[var(--color-border)] text-[var(--color-text)] hover:bg-[var(--color-bg-hover)]`}>Отправить мне сейчас</button>
      </div>
      {!data?.canEdit && data?.installed && <p className="text-xs text-[var(--color-text-muted)]">Менять настройки рассылки могут администраторы.</p>}
      {save.error && <p className="text-sm text-[var(--color-negative)]">{save.error.message}</p>}
      {digest.error && <p className="text-sm text-[var(--color-negative)]">{digest.error.message}</p>}
      {digest.data && (
        <div className="rounded-lg bg-[var(--color-bg)] p-3">
          {digest.variables === 'send_me' && (
            <p className="mb-2 text-xs text-[var(--color-text-secondary)]">{digest.data.sent ? 'Отправлено вам в Битрикс.' : 'Не отправлено (бот выключен общим рубильником или не настроен).'}</p>
          )}
          <pre className="whitespace-pre-wrap break-words font-sans text-sm text-[var(--color-text)]">
            {digest.data.text.replace(/\[\/?(B|I|U)\]/g, '').replace(/\[URL=([^\]]+)\]([^[]*)\[\/URL\]/g, '$2')}
          </pre>
        </div>
      )}
    </section>
  );
}
