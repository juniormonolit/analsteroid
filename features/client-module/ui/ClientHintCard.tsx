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
  const current = data.profile.clientType;
  if (!h || !data.profilesAvailable) return null;
  if (current === h.type && h.warnings.length === 0) return null;
  // Тип уже указан, но подсказка уверенно говорит другое — короткое «проверь».
  const disagrees = current !== null && current !== h.type;
  if (disagrees && h.confidence !== 'high' && h.warnings.length === 0) return null;

  const occupation = TYPES_WITH_OCCUPATION.has(h.type) ? (data.profile.occupation || h.occupation) : '';
  const accept = () => save({ client: { clientType: h.type, occupation, note: data.profile.note } });

  return (
    <div className="rounded-xl border border-[color-mix(in_srgb,var(--color-accent)_35%,transparent)] bg-[color-mix(in_srgb,var(--color-accent)_6%,transparent)] px-3.5 py-3">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <Sparkles size={15} className="shrink-0 text-[var(--color-accent)]" />
        <span className="text-[13.5px]">
          {current === null ? 'Похоже, это' : current === h.type ? 'Тип клиента' : `Указано «${typeLabel(current)}», но похоже на`}
          {' '}<b>{typeLabel(h.type)}</b>
          {occupation && <span className="text-[var(--color-text-muted)]"> · {occupation}</span>}
        </span>
        {h.confidence !== 'high' && <Chip>{h.confidence === 'medium' ? 'вероятно' : 'не уверены'}</Chip>}
      </div>
      <ul className="mt-1.5 flex list-disc flex-col gap-0.5 pl-6 text-[12.5px] text-[var(--color-text-muted)]">
        {h.reasons.map((r, i) => <li key={i}>{r}</li>)}
      </ul>
      {h.warnings.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-1">{h.warnings.map((w, i) => <Chip key={i} tone="neg">{w}</Chip>)}</div>
      )}
      {current !== h.type && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <button type="button" onClick={accept} disabled={saving}
            className="min-h-11 rounded-lg bg-[var(--color-accent)] px-4 text-[13px] font-semibold text-white disabled:opacity-60">
            {saving ? 'Сохраняем…' : current === null ? 'Да, заполнить' : `Сменить на «${typeLabel(h.type)}»`}
          </button>
          <button type="button" onClick={onEditClient} className="min-h-11 rounded-lg border border-[var(--color-border)] px-4 text-[13px]">
            {current === null ? 'Другой тип' : 'Оставить / уточнить'}
          </button>
          {error && <span className="text-[12px]" style={{ color: 'var(--color-negative, #e03131)' }}>{error}</span>}
        </div>
      )}
    </div>
  );
}
