'use client';
// Клиентские вызовы админки телевизоров + общие хелперы.
import type { TvMessage, TvMessageInput, TvScreen, TvScreenInput } from '../shared';

async function j<T>(res: Response): Promise<T> {
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `Ошибка ${res.status}`);
  return data as T;
}

export const tvApi = {
  listScreens: () => fetch('/api/tv/screens').then(r => j<{ screens: TvScreen[]; full: boolean }>(r)),
  createScreen: (input: TvScreenInput) => fetch('/api/tv/screens', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) }).then(r => j<{ screen: TvScreen }>(r)),
  updateScreen: (id: string, input: TvScreenInput) => fetch(`/api/tv/screens/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) }).then(r => j<{ screen: TvScreen }>(r)),
  deleteScreen: (id: string) => fetch(`/api/tv/screens/${id}`, { method: 'DELETE' }).then(r => j<{ ok: true }>(r)),
  pair: (id: string, code: string, label: string | null) => fetch(`/api/tv/screens/${id}/pair`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code, label }) }).then(r => j<{ ok: true; screen: TvScreen }>(r)),
  rotateToken: (id: string) => fetch(`/api/tv/screens/${id}/token`, { method: 'POST' }).then(r => j<{ publicToken: string }>(r)),
  setTicker: (id: string, text: string | null, enabled: boolean, deptId: string | null) => fetch(`/api/tv/screens/${id}/ticker`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, enabled, deptId }) }).then(r => j<{ screen: TvScreen }>(r)),
  unpair: (deviceId: string) => fetch(`/api/tv/devices/${deviceId}`, { method: 'DELETE' }).then(r => j<{ screen: TvScreen }>(r)),
  labelDevice: (deviceId: string, label: string | null) => fetch(`/api/tv/devices/${deviceId}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ label }) }).then(r => j<{ screen: TvScreen }>(r)),
  listMessages: () => fetch('/api/tv/messages').then(r => j<{ messages: TvMessage[] }>(r)),
  createMessage: (input: TvMessageInput) => fetch('/api/tv/messages', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) }).then(r => j<{ ok: true; id: string }>(r)),
  stopMessage: (id: string) => fetch(`/api/tv/messages/${id}`, { method: 'DELETE' }).then(r => j<{ ok: true }>(r)),
  uploadMedia: (mime: string, base64: string) => fetch('/api/tv/media', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mime, data: base64 }) }).then(r => j<{ id: string; url: string }>(r)),
};

/** Ужать картинку до ≤1920px по большей стороне и отдать JPEG base64 (без префикса data:). */
export function shrinkImage(file: File, maxSide = 1920, quality = 0.85): Promise<{ mime: string; base64: string; preview: string }> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const k = Math.min(1, maxSide / Math.max(img.width, img.height));
      const w = Math.max(1, Math.round(img.width * k)), h = Math.max(1, Math.round(img.height * k));
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      const ctx = canvas.getContext('2d');
      if (!ctx) { URL.revokeObjectURL(url); reject(new Error('Canvas недоступен')); return; }
      ctx.drawImage(img, 0, 0, w, h);
      const dataUrl = canvas.toDataURL('image/jpeg', quality);
      URL.revokeObjectURL(url);
      resolve({ mime: 'image/jpeg', base64: dataUrl.slice(dataUrl.indexOf(',') + 1), preview: dataUrl });
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Не удалось прочитать картинку')); };
    img.src = url;
  });
}

export function screenUrl(publicToken: string): string {
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  return `${origin}/tv/s/${publicToken}`;
}

export function fmtAgo(iso: string | null): string {
  if (!iso) return 'ещё не выходил на связь';
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 90_000) return 'онлайн';
  const m = Math.round(ms / 60_000);
  if (m < 60) return `${m} мин назад`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} ч назад`;
  return `${Math.round(h / 24)} дн назад`;
}

export async function copyText(text: string): Promise<boolean> {
  try { await navigator.clipboard.writeText(text); return true; } catch { return false; }
}

export const INPUT_CLS = 'w-full border border-[var(--color-border)] rounded-lg px-3 py-2 text-base sm:text-sm bg-[var(--color-bg)] text-[var(--color-text)] outline-none focus:border-[var(--color-accent)] disabled:opacity-60';
export const LABEL_CLS = 'text-xs font-medium text-[var(--color-text-muted)] uppercase tracking-wider';
export const BTN_PRIMARY = 'inline-flex items-center justify-center gap-1.5 min-h-11 sm:min-h-9 px-3 rounded-lg bg-[var(--color-accent)] text-white text-sm font-medium hover:bg-[var(--color-accent-hover)] disabled:opacity-50';
export const BTN_SECONDARY = 'inline-flex items-center justify-center gap-1.5 min-h-11 sm:min-h-9 px-3 rounded-lg border border-[var(--color-border)] text-sm text-[var(--color-text)] hover:bg-[var(--color-bg-hover)] disabled:opacity-50';
export const BTN_DANGER = 'inline-flex items-center justify-center gap-1.5 min-h-11 sm:min-h-9 px-3 rounded-lg border border-[var(--color-negative)] text-sm text-[var(--color-negative)] hover:bg-[var(--color-negative-soft)] disabled:opacity-50';
