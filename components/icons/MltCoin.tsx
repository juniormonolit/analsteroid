// Иконка валюты MLT (ребренд задачи 2747, эталон — макет Серёги «MLT Coin»):
// синяя медаль #2E63D4, точечный ободок, MLT сверху, белая М с засечками,
// год снизу, ромбы по бокам. Цвета — производные от базового #2E63D4 по той
// же формуле, что в эталонном макете (mix к белому/тёмно-синему):
//   cLight #779ae3 · cBase #2e63d4 · cDark #234aa0 · cDeep #193575
//
// Два варианта:
//  - "full"   — полная медаль со всеми деталями (кошелёк, магазин, гача,
//               карточка награды, крупные места).
//  - "simple" — упрощённая: тот же градиентный синий круг + белая М с
//               засечками, БЕЗ надписей/ободка/точек/ромбов (строки балансов,
//               чипы «+50», уведомления, таблицы — мелкий масштаб).
//
// Symbol-ы регистрируются ОДИН раз через <MltCoinDefs/> (в layout
// app/(app)/layout.tsx), дальше везде — лёгкий <MltCoin variant size/>
// (<svg><use href="#mlt-coin-..."/></svg>), как в эталонном демо.

const MLT_YEAR = String(new Date().getFullYear());

export function MltCoinDefs() {
  return (
    <svg width="0" height="0" style={{ position: 'absolute' }} aria-hidden="true">
      <defs>
        <linearGradient id="mlt-edge" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#2e63d4" />
          <stop offset="1" stopColor="#193575" />
        </linearGradient>
        <linearGradient id="mlt-face" x1="0.15" y1="0" x2="0.85" y2="1">
          <stop offset="0" stopColor="#779ae3" />
          <stop offset="0.55" stopColor="#2e63d4" />
          <stop offset="1" stopColor="#234aa0" />
        </linearGradient>
        <linearGradient id="mlt-emboss" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#ffffff" />
          <stop offset="1" stopColor="#d9e6fb" />
        </linearGradient>
        <path id="mlt-arc-top" d="M 38 100 A 62 62 0 0 1 162 100" fill="none" />
        <path id="mlt-arc-bottom" d="M 33 100 A 67 67 0 0 0 167 100" fill="none" />
        <radialGradient id="mlt-sheen" cx="0.32" cy="0.25" r="0.9">
          <stop offset="0" stopColor="#ffffff" stopOpacity="0.38" />
          <stop offset="0.45" stopColor="#ffffff" stopOpacity="0.08" />
          <stop offset="1" stopColor="#ffffff" stopOpacity="0" />
        </radialGradient>

        {/* ── Полная медаль ── */}
        <symbol id="mlt-coin-full" viewBox="0 0 200 200">
          <circle cx="100" cy="100" r="99" fill="#193575" />
          <circle cx="100" cy="100" r="97" fill="url(#mlt-edge)" />
          <circle cx="100" cy="100" r="96" fill="none" stroke="#193575" strokeWidth="5" strokeDasharray="2.4 3.1" />
          <circle cx="100" cy="100" r="91" fill="url(#mlt-face)" />
          <circle cx="100" cy="100" r="87" fill="none" stroke="#193575" strokeOpacity="0.5" strokeWidth="6" strokeDasharray="2.6 3.11" />
          <circle cx="100" cy="100" r="83.5" fill="none" stroke="#ffffff" strokeOpacity="0.5" strokeWidth="1.2" />
          <circle cx="100" cy="100" r="78" fill="none" stroke="#ffffff" strokeOpacity="0.6" strokeWidth="2.6" strokeDasharray="0 6.81" strokeLinecap="round" />
          <g stroke="#ffffff" strokeOpacity="0.06" strokeWidth="1.2">
            <line x1="100" y1="30" x2="100" y2="170" />
            <line x1="100" y1="30" x2="100" y2="170" transform="rotate(15 100 100)" />
            <line x1="100" y1="30" x2="100" y2="170" transform="rotate(30 100 100)" />
            <line x1="100" y1="30" x2="100" y2="170" transform="rotate(45 100 100)" />
            <line x1="100" y1="30" x2="100" y2="170" transform="rotate(60 100 100)" />
            <line x1="100" y1="30" x2="100" y2="170" transform="rotate(75 100 100)" />
            <line x1="100" y1="30" x2="100" y2="170" transform="rotate(90 100 100)" />
            <line x1="100" y1="30" x2="100" y2="170" transform="rotate(105 100 100)" />
            <line x1="100" y1="30" x2="100" y2="170" transform="rotate(120 100 100)" />
            <line x1="100" y1="30" x2="100" y2="170" transform="rotate(135 100 100)" />
            <line x1="100" y1="30" x2="100" y2="170" transform="rotate(150 100 100)" />
            <line x1="100" y1="30" x2="100" y2="170" transform="rotate(165 100 100)" />
          </g>
          <circle cx="100" cy="100" r="72" fill="none" stroke="#ffffff" strokeOpacity="0.35" strokeWidth="1" />
          <circle cx="100" cy="100" r="70" fill="none" stroke="#193575" strokeOpacity="0.35" strokeWidth="1" />
          <g transform="translate(0,-2)">
            <path d="M56 70 L84 70 L100 112 L116 70 L144 70 L144 77 L137 79 L137 131 L144 133 L144 138 L110 138 L110 133 L117 131 L117 93 L103 130 L97 130 L83 93 L83 131 L90 133 L90 138 L56 138 L56 133 L63 131 L63 79 L56 77 Z" fill="#193575" opacity="0.6" transform="translate(0 2.8)" />
            <path d="M56 70 L84 70 L100 112 L116 70 L144 70 L144 77 L137 79 L137 131 L144 133 L144 138 L110 138 L110 133 L117 131 L117 93 L103 130 L97 130 L83 93 L83 131 L90 133 L90 138 L56 138 L56 133 L63 131 L63 79 L56 77 Z" fill="url(#mlt-emboss)" />
          </g>
          <g transform="translate(0 1.6)" opacity="0.55">
            <text fontFamily="Cinzel, serif" fontWeight={700} fontSize="16" letterSpacing="9" fill="#193575">
              <textPath href="#mlt-arc-top" startOffset="50%" textAnchor="middle">MLT</textPath>
            </text>
          </g>
          <text fontFamily="Cinzel, serif" fontWeight={700} fontSize="16" letterSpacing="9" fill="#ffffff">
            <textPath href="#mlt-arc-top" startOffset="50%" textAnchor="middle">MLT</textPath>
          </text>
          <g transform="translate(0 1.4)" opacity="0.5">
            <text fontFamily="Cinzel, serif" fontWeight={700} fontSize="13" letterSpacing="6" fill="#193575">
              <textPath href="#mlt-arc-bottom" startOffset="50%" textAnchor="middle">{MLT_YEAR}</textPath>
            </text>
          </g>
          <text fontFamily="Cinzel, serif" fontWeight={700} fontSize="13" letterSpacing="6" fill="#ffffff" fillOpacity="0.92">
            <textPath href="#mlt-arc-bottom" startOffset="50%" textAnchor="middle">{MLT_YEAR}</textPath>
          </text>
          <g fill="#ffffff" fillOpacity="0.8">
            <rect x="31" y="96" width="8" height="8" transform="rotate(45 35 100)" />
            <rect x="161" y="96" width="8" height="8" transform="rotate(45 165 100)" />
          </g>
          <circle cx="100" cy="100" r="91" fill="url(#mlt-sheen)" />
        </symbol>

        {/* ── Упрощённая: круг + М, без надписей/точек/ромбов ── */}
        <symbol id="mlt-coin-simple" viewBox="0 0 200 200">
          <circle cx="100" cy="100" r="99" fill="#193575" />
          <circle cx="100" cy="100" r="97" fill="url(#mlt-edge)" />
          <circle cx="100" cy="100" r="91" fill="url(#mlt-face)" />
          <g transform="translate(0,0)">
            <path d="M56 70 L84 70 L100 112 L116 70 L144 70 L144 77 L137 79 L137 131 L144 133 L144 138 L110 138 L110 133 L117 131 L117 93 L103 130 L97 130 L83 93 L83 131 L90 133 L90 138 L56 138 L56 133 L63 131 L63 79 L56 77 Z" fill="#193575" opacity="0.6" transform="translate(0 2.8)" />
            <path d="M56 70 L84 70 L100 112 L116 70 L144 70 L144 77 L137 79 L137 131 L144 133 L144 138 L110 138 L110 133 L117 131 L117 93 L103 130 L97 130 L83 93 L83 131 L90 133 L90 138 L56 138 L56 133 L63 131 L63 79 L56 77 Z" fill="url(#mlt-emboss)" />
          </g>
          <circle cx="100" cy="100" r="91" fill="url(#mlt-sheen)" />
        </symbol>
      </defs>
    </svg>
  );
}

export function MltCoin({
  variant = 'simple', size = 20, className, title,
}: {
  variant?: 'full' | 'simple'; size?: number; className?: string; title?: string;
}) {
  return (
    <svg width={size} height={size} viewBox="0 0 200 200" className={className} role="img" aria-label={title ?? 'MLT'}>
      {title && <title>{title}</title>}
      <use href={`#mlt-coin-${variant}`} />
    </svg>
  );
}
