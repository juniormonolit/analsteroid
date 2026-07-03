// Летящий горящий метеорит — направление вправо-вверх.
// Слоистый «огненный шлейф» (жёлтый → оранжевый → горячее ядро) + каменная голова с кратерами.
export function MeteorLogo({ size = 24, className }: { size?: number; className?: string }) {
  // viewBox 64×40, голова камня в (44,16), весь метеор повёрнут на -30° (летит вправо-вверх).
  const h = size;
  const w = (size * 64) / 40;
  return (
    <svg
      width={w}
      height={h}
      viewBox="0 0 64 40"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-hidden="true"
    >
      <defs>
        <linearGradient id="ml-flameY" x1="0" y1="0.5" x2="1" y2="0.5">
          <stop offset="0" stopColor="#FCD34D" stopOpacity="0" />
          <stop offset="0.45" stopColor="#FBBF24" stopOpacity="0.85" />
          <stop offset="1" stopColor="#FDE047" />
        </linearGradient>
        <linearGradient id="ml-flameO" x1="0" y1="0.5" x2="1" y2="0.5">
          <stop offset="0" stopColor="#F97316" stopOpacity="0" />
          <stop offset="0.5" stopColor="#FB923C" stopOpacity="0.95" />
          <stop offset="1" stopColor="#F97316" />
        </linearGradient>
        <linearGradient id="ml-flameH" x1="0" y1="0.5" x2="1" y2="0.5">
          <stop offset="0" stopColor="#FEF3C7" stopOpacity="0" />
          <stop offset="1" stopColor="#FEF08A" />
        </linearGradient>
        <radialGradient id="ml-rock" cx="0.35" cy="0.3" r="0.85">
          <stop offset="0" stopColor="#A8A29E" />
          <stop offset="0.55" stopColor="#57534E" />
          <stop offset="1" stopColor="#292524" />
        </radialGradient>
      </defs>

      <g transform="rotate(-30 44 16)">
        {/* Жёлтое внешнее пламя */}
        <circle cx="44" cy="16" r="12.5" fill="url(#ml-flameY)" />
        <path d="M0,16 C16,9 28,7 44,7 L44,25 C28,25 16,23 0,16 Z" fill="url(#ml-flameY)" />

        {/* Оранжевое пламя */}
        <circle cx="44" cy="16" r="9" fill="url(#ml-flameO)" />
        <path d="M5,16 C18,11 30,9 44,9.5 L44,22.5 C30,23 18,21 5,16 Z" fill="url(#ml-flameO)" />

        {/* Горячее светлое ядро шлейфа */}
        <circle cx="44" cy="16" r="5.5" fill="url(#ml-flameH)" />
        <path d="M14,16 C26,13.5 35,12.5 44,13 L44,19 C35,19.5 26,18.5 14,16 Z" fill="url(#ml-flameH)" />

        {/* Огненные «искры»-завитки вокруг головы (как на наброске) */}
        <circle cx="40" cy="7.5" r="2.1" fill="#FDE047" opacity="0.8" />
        <circle cx="47" cy="6.5" r="1.7" fill="#FBBF24" opacity="0.75" />
        <circle cx="51.5" cy="9.5" r="1.5" fill="#FDE047" opacity="0.7" />
        <circle cx="50" cy="23" r="1.6" fill="#FB923C" opacity="0.7" />

        {/* Каменная голова метеорита */}
        <circle cx="44" cy="16" r="7.6" fill="url(#ml-rock)" stroke="#1C1917" strokeWidth="0.6" />
        {/* Кратеры */}
        <ellipse cx="41.5" cy="13.5" rx="1.7" ry="1.4" fill="#3F3A36" opacity="0.85" />
        <ellipse cx="46" cy="17.5" rx="2.1" ry="1.7" fill="#352F2B" opacity="0.85" />
        <circle cx="43" cy="18.5" r="1" fill="#3F3A36" opacity="0.8" />
        {/* Блик на ведущей кромке */}
        <path d="M47,11 A7.6,7.6 0 0 1 50.5,17" stroke="#E7E5E4" strokeWidth="1" strokeLinecap="round" opacity="0.55" fill="none" />
      </g>
    </svg>
  );
}
