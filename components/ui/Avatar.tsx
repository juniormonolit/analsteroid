'use client';
import { useState } from 'react';

// Аватар пользователя: фото из Битрикса, при отсутствии/ошибке загрузки —
// плашка с инициалами и детерминированным цветом по имени.
//
// shape (задача 3045): дизайн-пакет Glass2 показывает в шапке ЛК КРУПНОЕ фото
// скруглённым квадратом (ui_kits/monolitika/profile.html, 220×220, radius 24), а не
// кругом. Форма — проп с дефолтом 'circle', поэтому все существующие вызовы
// (сайдбар, списки, гриды — размеры 24-72) остаются круглыми без правок.

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

export function Avatar({ name, url, size = 32, shape = 'circle' }: {
  name: string; url?: string | null; size?: number; shape?: 'circle' | 'rounded';
}) {
  const [broken, setBroken] = useState(false);
  // Радиус скруглённого квадрата держим пропорцией от размера (как в макете:
  // 24 при 220 ≈ 11%), иначе на маленьких размерах угол выглядел бы рубленым.
  const radiusCls = shape === 'circle' ? 'rounded-full' : '';
  const radiusStyle = shape === 'circle' ? undefined : { borderRadius: Math.round(size * 0.11) };

  if (url && !broken) {
    return (
      // eslint-disable-next-line @next/next/no-img-element -- внешний URL Bitrix-портала, next/image не настроен под него
      <img
        src={url}
        alt={name}
        width={size}
        height={size}
        onError={() => setBroken(true)}
        className={`${radiusCls} object-cover shrink-0`}
        style={{ width: size, height: size, ...radiusStyle }}
      />
    );
  }

  return (
    <div
      aria-label={name}
      className={`${radiusCls} flex items-center justify-center text-white font-medium shrink-0 select-none`}
      style={{ width: size, height: size, backgroundColor: colorFor(name), fontSize: Math.round(size * 0.38), ...radiusStyle }}
    >
      {initials(name)}
    </div>
  );
}
