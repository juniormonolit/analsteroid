'use client';
// «Похоже, это …» на «Обзоре» (владелец 15.10): система сама предлагает тип
// клиента по сделкам, объектам и ЕГРЮЛ (engine/clientHint.ts), менеджер
// подтверждает одним нажатием или выбирает другой. Когда тип уже указан и с
// подсказкой согласен — карточки нет, остаётся строка ЕГРЮЛ.

import { Sparkles, Landmark } from 'lucide-react';
import { type ClientModuleData, CLIENT_TYPES, TYPES_WITH_OCCUPATION } from '../engine/types';
import { Chip, useSave } from './parts';

const typeLabel = (t: string | null) => CLIENT_TYPES.find(x => x.value === t)?.label ?? null;
const STATUS: Record<string, string> = { active: 'действует', liquidating: 'ликвидируется', liquidated: 'ликвидирована', other: 'статус неизвестен' };

export function LegalLine({ data }: { data: ClientModuleData }) {
  const l = data.legal;
  if (!l) return null;
  const year = l.registeredAt?.slice(0, 4);
  return (
    <div className="flex items-start gap-1.5 px-0.5 text-[12px] text-[var(--color-text-muted)]">
      <Landmark size={13} className="mt-0.5 shrink-0" />
      <span className="min-w-0">
        <span className="text-[var(--color-text)]">{l.name}</span>
        {l.okved && <> · ОКВЭД {l.okved}{l.okvedName ? ` ${l.okvedName}` : ''}</>}
        {year && <> · с {year}</>}
        {' · '}<span style={l.status === 'active' ? undefined : { color: 'var(--color-negative, #e03131)' }}>{STATUS[l.status]}</span>
      </span>
    </div>
  );
}

export function ClientHintCard({ data, params, onEditClient }: {
  data: ClientModuleData;
  params: Record<string, string>;
  onEditClient: () => void;
}) {
  const { save, saving, error } = useSave(params);
  const h = data.hint;
  // «Строит себе» любой стадии подсказка не оспаривает — стадию знает менеджер.
  const current = data.profile.clientType === 'self_builder_late' && h?.type === 'self_builder' ? 'self_builder' : data.profile.clientType;
  if (!h || !data.profilesAvailable) return null;
  if (current === h.type && h.warnings.length === 0) return null;
  // Тип не указан — подсказка живёт в шапке (ClientBar); здесь только «спорю с указанным» и тревоги ЕГРЮЛ.
  if (current === null && h.warnings.length === 0) return null;
  // Тип уже указан, но подсказка уверенно говорит другое — короткое «проверь».
  const disagrees = current !== null && current !== h.type;
  if (disagrees && h.confidence !== 'high' && h.warnings.length === 0) return null;

  const occupation = TYPES_WITH_OCCUPATION.has(h.type) ? (data.profile.occupation || h.occupation) : '';
  const accept = () => save({ client: { clientType: h.type, occupation, note: data.profile.note } });

  // Аудит 15.10: подсказка — одна строка с кнопками, причины — по «почему?»
  // (раньше занимала первый экран целиком, а нужна один раз на клиента).
  return (
    <div className="rounded-xl border border-[color-mix(in_srgb,var(--color-accent)_30%,transparent)] bg-[color-mix(in_srgb,var(--color-accent)_5%,transparent)] px-3 py-2">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
        <Sparkles size={15} className="shrink-0 text-[var(--color-accent)]" />
        <span className="min-w-0 flex-1 text-[13.5px]">
          {current === null ? 'Похоже, это' : current === h.type ? 'Тип клиента' : `Указано «${typeLabel(current)}», но похоже на`}
          {' '}<b>{typeLabel(h.type)}</b>
          {occupation && <span className="text-[var(--color-text-muted)]"> · {occupation}</span>}
          {h.confidence !== 'high' && <span className="text-[var(--color-text-muted)]"> · {h.confidence === 'medium' ? 'вероятно' : 'не уверены'}</span>}
        </span>
        {current !== null && current !== h.type && (
          <span className="flex shrink-0 gap-1.5">
            <button type="button" onClick={accept} disabled={saving}
              className="min-h-10 rounded-lg bg-[var(--color-accent)] px-3.5 text-[13px] font-semibold text-white disabled:opacity-60">
              {saving ? 'Сохраняем…' : current === null ? 'Да' : 'Сменить'}
            </button>
            <button type="button" onClick={onEditClient} className="min-h-10 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-surface)] px-3 text-[13px]">
              {current === null ? 'Другой' : 'Оставить'}
            </button>
          </span>
        )}
      </div>
      {h.warnings.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-1">{h.warnings.map((w, i) => <Chip key={i} tone="neg">{w}</Chip>)}</div>
      )}
      <details className="mt-0.5 text-[12.5px] text-[var(--color-text-muted)]">
        <summary className="inline-flex min-h-8 cursor-pointer select-none items-center">почему?</summary>
        <ul className="flex list-disc flex-col gap-0.5 pb-1 pl-5">{h.reasons.map((r, i) => <li key={i}>{r}</li>)}</ul>
      </details>
      {error && <div className="text-[12px]" style={{ color: 'var(--color-negative, #e03131)' }}>{error}</div>}
    </div>
  );
}
