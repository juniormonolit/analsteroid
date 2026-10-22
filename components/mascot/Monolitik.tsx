'use client';
import { useId, type ReactNode } from 'react';
import './monolitik.css';

/**
 * Монолитик — талисман приложения (тот же робот, что на фавиконе app/icon.png):
 * тёмная «каменная» голова-монитор с жёлтыми светящимися глазами, оранжевый
 * логотип «М» со столбиками на груди. Рисунок — inline SVG (viewBox 120×150),
 * позы отличаются рукой, лицом и деталями, движение — только CSS
 * (monolitik.css), при prefers-reduced-motion всё замирает.
 *
 * Позы под этапы ИИ-анализа звонков в карточке клиента:
 * hello — вкладка открыта; think — запуск; work — идёт анализ;
 * done — отчёт готов; wink — подсказка; warn — риски; alert — ошибка /
 * нет денег на API; sleep — нет звонков. Облачко с текстом и прогрессом —
 * MonolitikHelper.
 */
export type MonolitikPose = 'hello' | 'think' | 'work' | 'done' | 'wink' | 'warn' | 'alert' | 'sleep';

export const MONOLITIK_POSES: { pose: MonolitikPose; label: string; hint: string }[] = [
  { pose: 'hello', label: 'Привет', hint: 'вкладка открыта' },
  { pose: 'think', label: 'Думает', hint: 'запуск анализа' },
  { pose: 'work', label: 'Читает звонки', hint: 'идёт анализ' },
  { pose: 'done', label: 'Готово', hint: 'отчёт готов' },
  { pose: 'wink', label: 'Подсказка', hint: '«вставить памятку в задачу»' },
  { pose: 'warn', label: 'Внимание', hint: 'риск / обещание клиенту' },
  { pose: 'alert', label: 'Тревога', hint: 'ошибка / нет денег на API' },
  { pose: 'sleep', label: 'Спит', hint: 'нет звонков для анализа' },
];

export interface MonolitikProps {
  pose?: MonolitikPose;
  /** Ширина в px; высота = size × 1.25. */
  size?: number;
  /** false — без движения (мелкие аватарки, списки). */
  animated?: boolean;
  className?: string;
  /** Подпись для скринридера; без неё рисунок декоративный (aria-hidden). */
  title?: string;
}

const W = 120;
const H = 150;

export function Monolitik({ pose = 'hello', size = 120, animated = true, className, title }: MonolitikProps) {
  // Уникальные id градиентов/фильтра на каждый экземпляр: на странице может
  // быть несколько роботов, а url(#id) ищет первый в документе.
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const id = (n: string) => `mlk-${n}-${uid}`;
  const url = (n: string) => `url(#${id(n)})`;
  const glow = url('glow');

  const body = url('body');
  const part = url('part');

  // Тело под позу: дыхание, прыжок, дрожь или сонное посапывание.
  const rootAnim =
    pose === 'done' ? 'mlk-hop' : pose === 'alert' ? 'mlk-shake' : pose === 'sleep' ? 'mlk-snore' : 'mlk-root';

  // Наклон головы — немного характера без отдельной анимации.
  const headTilt = pose === 'think' ? 'rotate(5 60 78)' : pose === 'sleep' ? 'rotate(-6 60 78) translate(0 2)' : undefined;

  const mouth = { className: 'mlk-mouth', stroke: 'var(--mlk-glow)', strokeWidth: 3, fill: 'none', strokeLinecap: 'round' as const };

  const armDown = (
    <g>
      <rect className="mlk-rim" x="88" y="82" width="16" height="30" rx="6" fill={part} />
      <rect className="mlk-rim" x="86" y="108" width="20" height="14" rx="5" fill={body} />
      <rect x="90" y="84" width="8" height="3" rx="1.5" fill="var(--mlk-led)" opacity=".85" />
    </g>
  );

  const eyesOpen = (cls?: string) => (
    <g className={cls} filter={glow} fill="var(--mlk-glow)">
      <rect x="41" y="42" width="10" height="16" rx="5" />
      <rect x="69" y="42" width="10" height="16" rx="5" />
    </g>
  );

  const smile = <path {...mouth} filter={glow} d="M53 63 q7 6 14 0" />;

  let rightArm: ReactNode = armDown;
  let face: ReactNode = (
    <>
      {eyesOpen('mlk-blink')}
      {smile}
    </>
  );
  let extras: ReactNode = null;
  let headExtras: ReactNode = null;

  switch (pose) {
    case 'hello':
      rightArm = (
        <g transform="rotate(-140 96 84)">
          <g className="mlk-wave">
            <rect className="mlk-rim" x="88" y="82" width="16" height="30" rx="6" fill={part} />
            <rect className="mlk-rim" x="85" y="106" width="22" height="16" rx="6" fill={body} />
          </g>
        </g>
      );
      break;
    case 'think':
      rightArm = (
        <g>
          <rect className="mlk-rim" x="88" y="82" width="16" height="22" rx="6" fill={part} transform="rotate(35 96 84)" />
          <rect className="mlk-rim" x="72" y="90" width="18" height="15" rx="5" fill={body} />
        </g>
      );
      face = (
        <>
          <g transform="translate(4 -3)">
            <g filter={glow} fill="var(--mlk-glow)" className="mlk-blink">
              <rect x="41" y="42" width="10" height="14" rx="5" />
              <rect x="69" y="42" width="10" height="14" rx="5" />
            </g>
          </g>
          <path {...mouth} filter={glow} d="M56 65 h9" />
        </>
      );
      extras = (
        <g className="mlk-dots">
          <circle cx="46" cy="9" r="4" />
          <circle cx="60" cy="6" r="4" />
          <circle cx="74" cy="9" r="4" />
        </g>
      );
      break;
    case 'work':
      rightArm = (
        <g className="mlk-flip">
          <rect className="mlk-rim" x="88" y="82" width="16" height="22" rx="6" fill={part} transform="rotate(-25 96 84)" />
          <g transform="rotate(-8 107 104)">
            <rect x="96" y="90" width="22" height="28" rx="2" fill="var(--mlk-paper)" stroke="var(--mlk-paper-line)" strokeWidth=".8" />
            <path d="M100 97 h13 M100 102 h15 M100 107 h11 M100 112 h14" stroke="var(--mlk-paper-line)" strokeWidth="1.6" />
            <path d="M100 92 l3 0" stroke="var(--mlk-led)" strokeWidth="2" strokeLinecap="round" />
          </g>
          <rect className="mlk-rim" x="94" y="98" width="13" height="12" rx="4" fill={body} />
        </g>
      );
      face = (
        <>
          <g className="mlk-scan">{eyesOpen()}</g>
          {smile}
        </>
      );
      break;
    case 'done':
      rightArm = (
        <g>
          <rect className="mlk-rim" x="88" y="82" width="16" height="22" rx="6" fill={part} transform="rotate(-35 96 84)" />
          <rect x="100" y="68" width="28" height="22" rx="3" fill={url('screen')} stroke="var(--mlk-edge)" />
          <g filter={glow}>
            <path d="M104 85 l6 -6 5 3 8 -9" stroke="var(--mlk-logo)" strokeWidth="2.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
            <path d="M119 72 l5 -1 -1 5" stroke="var(--mlk-logo)" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
          </g>
          <rect className="mlk-rim" x="95" y="86" width="13" height="13" rx="4" fill={body} />
        </g>
      );
      face = (
        <>
          <path {...mouth} filter={glow} d="M40 52 q6 -8 12 0 M68 52 q6 -8 12 0" />
          <path d="M50 59 q10 11 20 0 z" fill="var(--mlk-logo)" filter={glow} />
        </>
      );
      break;
    case 'wink':
      rightArm = (
        <g>
          <rect className="mlk-rim" x="88" y="82" width="16" height="24" rx="6" fill={part} />
          <g className="mlk-thumb">
            <rect className="mlk-rim" x="86" y="102" width="20" height="14" rx="5" fill={body} />
            <rect className="mlk-rim" x="99" y="90" width="7" height="15" rx="3" fill={body} />
          </g>
        </g>
      );
      face = (
        <>
          <g filter={glow} fill="var(--mlk-glow)">
            <rect x="41" y="42" width="10" height="16" rx="5" />
          </g>
          <path {...mouth} filter={glow} d="M67 52 q6 -6 12 0" />
          <path {...mouth} filter={glow} d="M52 62 q8 6 16 -1" />
        </>
      );
      break;
    case 'warn':
      face = (
        <>
          {eyesOpen('mlk-blink')}
          <path {...mouth} filter={glow} d="M54 66 q6 -4 12 0" />
        </>
      );
      extras = (
        // CSS-анимация перетирает transform-атрибут — сдвиг на внешней группе
        <g transform="translate(-6 0)">
          <g className="mlk-sign">
            <path d="M14 96 L30 68 L46 96 Z" fill={url('warn')} stroke="#ffb35c" strokeWidth="2" strokeLinejoin="round" />
            <rect x="28" y="76" width="4" height="11" rx="2" fill="#26282c" />
            <circle cx="30" cy="91" r="2.2" fill="#26282c" />
          </g>
        </g>
      );
      break;
    case 'alert':
      face = (
        <>
          <path {...mouth} filter={glow} d="M40 42 l11 5 M80 42 l-11 5" />
          <g filter={glow}>
            <rect x="42" y="48" width="9" height="11" rx="4" fill="var(--mlk-glow)" />
            <rect x="69" y="48" width="9" height="11" rx="4" fill="var(--mlk-danger)" />
          </g>
          <path {...mouth} filter={glow} d="M54 67 q6 -4 12 0" />
        </>
      );
      headExtras = (
        <g>
          <rect className="mlk-rim" x="51" y="12" width="18" height="9" rx="2" fill={part} />
          <path className="mlk-siren" d="M53 13 a7 7 0 0 1 14 0 z" fill="var(--mlk-danger)" filter={glow} />
        </g>
      );
      break;
    case 'sleep':
      face = (
        <>
          <path {...mouth} filter={glow} d="M40 52 q6 5 12 0 M68 52 q6 5 12 0" />
          <path {...mouth} filter={glow} d="M56 64 h8" />
        </>
      );
      extras = (
        <g>
          <text className="mlk-z" x="98" y="24">z</text>
          <text className="mlk-z" x="104" y="15">z</text>
          <text className="mlk-z" x="110" y="6">Z</text>
        </g>
      );
      break;
  }

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      width={size}
      height={Math.round((size * H) / W)}
      className={`mlk${animated ? '' : ' mlk-static'}${className ? ` ${className}` : ''}`}
      role={title ? 'img' : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      focusable="false"
    >
      <defs>
        <linearGradient id={id('body')} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" style={{ stopColor: 'var(--mlk-body-hi)' }} />
          <stop offset="1" style={{ stopColor: 'var(--mlk-body-lo)' }} />
        </linearGradient>
        <linearGradient id={id('part')} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" style={{ stopColor: 'var(--mlk-part-hi)' }} />
          <stop offset="1" style={{ stopColor: 'var(--mlk-part-lo)' }} />
        </linearGradient>
        <radialGradient id={id('screen')} cx=".45" cy=".35" r=".8">
          <stop offset="0" style={{ stopColor: 'var(--mlk-screen-hi)' }} />
          <stop offset="1" style={{ stopColor: 'var(--mlk-screen-lo)' }} />
        </radialGradient>
        <linearGradient id={id('shine')} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#fff" stopOpacity=".1" />
          <stop offset=".45" stopColor="#fff" stopOpacity="0" />
        </linearGradient>
        <linearGradient id={id('warn')} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#ffb340" />
          <stop offset="1" stopColor="#ff7a12" />
        </linearGradient>
        <filter id={id('glow')} x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur in="SourceGraphic" stdDeviation="1.5" result="b" />
          <feMerge>
            <feMergeNode in="b" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>

      {title && <title>{title}</title>}

      {/* тень на полу — не дышит вместе с телом */}
      <ellipse cx="60" cy="143" rx="30" ry="3.5" fill="#000" opacity=".12" />

      <g key={pose} className="mlk-enter">
        <g className={rootAnim}>
          {/* ноги */}
          <rect className="mlk-rim" x="36" y="116" width="20" height="20" rx="4" fill={part} />
          <rect className="mlk-rim" x="64" y="116" width="20" height="20" rx="4" fill={part} />
          <rect className="mlk-rim" x="33" y="131" width="26" height="9" rx="3" fill={body} />
          <rect className="mlk-rim" x="61" y="131" width="26" height="9" rx="3" fill={body} />

          {/* корпус с фаской сверху */}
          <rect className="mlk-rim" x="30" y="76" width="60" height="46" rx="10" fill={body} />
          <rect x="34" y="79" width="52" height="4" rx="2" fill="#fff" opacity=".1" />
          <rect x="34" y="116" width="52" height="3" rx="1.5" fill="#000" opacity=".18" />

          {/* логотип «М» со столбиками */}
          <g fill="var(--mlk-logo)" filter={glow} className={pose === 'work' ? 'mlk-pulse' : undefined}>
            <path d="M44 112 V92 h5 l6 9 6-9 h5 v20 h-5 v-11 l-6 8 -6-8 v11 z" />
            <rect x="69" y="105" width="3.5" height="7" rx="1" />
            <rect x="74" y="100" width="3.5" height="12" rx="1" />
            <rect x="79" y="95" width="3.5" height="17" rx="1" />
          </g>

          {/* левая рука — всегда опущена */}
          <g>
            <rect className="mlk-rim" x="16" y="82" width="16" height="30" rx="6" fill={part} />
            <rect className="mlk-rim" x="14" y="108" width="20" height="14" rx="5" fill={body} />
            <rect x="22" y="84" width="8" height="3" rx="1.5" fill="var(--mlk-led)" opacity=".85" />
          </g>

          {/* голова */}
          <g transform={headTilt}>
            {headExtras}
            <rect className="mlk-rim" x="13" y="37" width="11" height="26" rx="4" fill={part} />
            <rect className="mlk-rim" x="96" y="37" width="11" height="26" rx="4" fill={part} />
            <rect x="15" y="54" width="3" height="6" rx="1.5" fill="var(--mlk-led)" opacity=".8" />
            <rect x="102" y="54" width="3" height="6" rx="1.5" fill="var(--mlk-led)" opacity=".8" />
            <rect className="mlk-rim" x="20" y="20" width="80" height="60" rx="14" fill={body} />
            <rect x="25" y="22.5" width="70" height="4" rx="2" fill="#fff" opacity=".14" />
            <rect x="26" y="29" width="68" height="46" rx="11" fill="#000" opacity=".35" />
            <rect x="27" y="30" width="66" height="44" rx="10" fill={url('screen')} />
            {face}
            <rect x="27" y="30" width="66" height="44" rx="10" fill={url('shine')} pointerEvents="none" />
          </g>

          {rightArm}
          {extras}
        </g>
      </g>
    </svg>
  );
}
