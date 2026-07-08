'use client';
import { useState } from 'react';

// Аватар пользователя: фото из Битрикса, при отсутствии/ошибке загрузки —
// круг с инициалами и детерминированным цветом по имени.

const PALETTE = ['#6366f1', '#0ea5e9', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899', '#14b8a6'];

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

function colorFor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) | 0;
  return PALETTE[Math.abs(hash) % PALETTE.length];
}

export function Avatar({ name, url, size = 32 }: { name: string; url?: string | null; size?: number }) {
  const [broken, setBroken] = useState(false);

  if (url && !broken) {
    return (
      // eslint-disable-next-line @next/next/no-img-element -- внешний URL Bitrix-портала, next/image не настроен под него
      <img
        src={url}
        alt={name}
        width={size}
        height={size}
        onError={() => setBroken(true)}
        className="rounded-full object-cover shrink-0"
        style={{ width: size, height: size }}
      />
    );
  }

  return (
    <div
      aria-label={name}
      className="rounded-full flex items-center justify-center text-white font-medium shrink-0 select-none"
      style={{ width: size, height: size, backgroundColor: colorFor(name), fontSize: Math.round(size * 0.38) }}
    >
      {initials(name)}
    </div>
  );
}
