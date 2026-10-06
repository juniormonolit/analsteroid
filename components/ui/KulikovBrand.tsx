// Логотип темы «Дизайн Куликова» (data-theme="kulikov", задача #8857) — маскот
// Монолитик. Эталон — docs/design/monolitika-redesign-monolitshop-20261006/
// logo-robot.html: вариант «а» (робот в полный рост, вертикальная черта,
// «МОНОЛИТИКА / аналитика») для развёрнутого сайдбара и голова на плитке — для
// свёрнутого. Картинки вырезаны из того же макета: public/brand/.
//
// Компоненты НЕ знают о теме. Их рендерят рядом с обычным BrandLogo, а показывает
// нужный вариант CSS по классам brand-default / brand-kulikov
// (app/styles/tokens/theme-kulikov.css) — без JS и без вспышки при загрузке.
// Цвета — токены темы (color-brand-ink, color-brand-tile), заданы там же.
//
// Обычный <img>, а не next/image: это два маленьких PNG из public/, оптимизатор
// изображений им не нужен.

/** Робот + черта + «МОНОЛИТИКА / аналитика». Высота робота — 56px, как в макете.
 *  compact — для мобильного меню (260px, рядом ещё крестик): робот 48px и кегль
 *  названия чуть меньше, иначе «МОНОЛИТИКА» обрезается многоточием. */
export function KulikovLockup({ compact = false }: { compact?: boolean }) {
  return (
    <span className={`flex items-center min-w-0 ${compact ? 'gap-2' : 'gap-3'}`}>
      <img
        src="/brand/monolitik-robot.png"
        width={compact ? 54 : 63}
        height={compact ? 48 : 56}
        alt=""
        aria-hidden="true"
        className="block shrink-0"
      />
      <span aria-hidden="true" className="w-0.5 h-9 shrink-0 rounded-[1px] bg-[var(--color-brand-ink)]" />
      <span className="flex flex-col min-w-0 leading-[1.15]">
        <span className={`truncate font-bold uppercase tracking-[0.04em] text-[var(--color-brand-ink)] ${compact ? 'text-[13px]' : 'text-[15px]'}`}>
          Монолитика
        </span>
        <span className="truncate text-xs font-medium text-[var(--color-sidebar-text-muted)]">аналитика</span>
      </span>
    </span>
  );
}

/** Голова робота на плитке — свёрнутая рельса (52px) и мобильная шапка.
 *  Пропорции макета: плитка 44px, голова 40×21. */
export function KulikovHead({ size = 36, className = '' }: { size?: number; className?: string }) {
  const headW = Math.round((size * 40) / 44);
  const headH = Math.round((headW * 21) / 40);
  return (
    <span
      className={`items-center justify-center shrink-0 overflow-hidden rounded-[10px] bg-[var(--color-brand-tile)] ${className}`}
      style={{ width: size, height: size }}
    >
      <img
        src="/brand/monolitik-head.png"
        width={headW}
        height={headH}
        alt=""
        aria-hidden="true"
        className="block"
      />
    </span>
  );
}
