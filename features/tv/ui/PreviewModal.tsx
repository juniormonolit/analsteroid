'use client';
// Превью экрана: тот же публичный HTML (/tv/s/<token>?preview=1) во фрейме 16:9.
// Страница телевизора целиком в vw-единицах, поэтому масштабируется сама —
// достаточно задать фрейму ширину, без transform/scale и измерений.
import { Modal } from '@/components/ui/Modal';
import { ExternalLink } from 'lucide-react';
import type { TvScreen } from '../shared';
import { BTN_SECONDARY, screenUrl } from './api';

export function PreviewModal({ screen, onClose }: { screen: TvScreen | null; onClose: () => void }) {
  const url = screen ? `${screenUrl(screen.publicToken)}?preview=1` : '';
  return (
    <Modal open={!!screen} onOpenChange={v => { if (!v) onClose(); }} title={screen ? `Превью — ${screen.name}` : ''} desktopWidth="sm:max-w-5xl">
      {screen && (
        <div className="flex flex-col gap-3">
          <div className="w-full max-w-full aspect-video rounded-lg overflow-hidden border border-[var(--color-border)] bg-black">
            <iframe key={screen.updatedAt} src={url} title="Превью экрана" className="w-full h-full border-0" />
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-[var(--color-text-muted)]">
            <span>Так экран выглядит на телевизоре. Данные — живые, обновляются каждые 15 секунд.</span>
            <a href={url.replace('?preview=1', '')} target="_blank" rel="noreferrer" className={BTN_SECONDARY}><ExternalLink size={14} /> Открыть на весь экран</a>
          </div>
        </div>
      )}
    </Modal>
  );
}
