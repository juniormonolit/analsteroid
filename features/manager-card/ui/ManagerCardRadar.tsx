'use client';

// SVG-«паутина» метрик карточки менеджера (см. мокап manager-card-mock.html,
// экран 1): 2 слоя — выбранный период (синий) и период СРАВНЕНИЯ (серый пунктир,
// задача 10.07 п.3 — было «всё время», переименовано вслед за сменой семантики:
// полупрозрачный слой = тот же период, что и колонка «к прошлому периоду»).
// Порядок осей = порядок выбранных осей шаблона карточки (card_templates,
// задача 10.07 п.2) — до 6 из полного каталога метрик, задаётся в
// /settings/card-templates, верх → по часовой стрелке.

export interface RadarAxisInput {
  key: string;
  label: string;
  periodValue: number | null;      // 0..10, нормировано перцентилем
  comparisonValue: number | null;  // 0..10, период сравнения
  dataAvailable: boolean;
}

// Карточка v4 (задача 10.07, п.3): паутина «заметно крупнее и выразительнее» —
// было 360×268/RADIUS 84 (владелец: «мелко, много пустого места под ней»).
// Увеличены холст, радиус, толщина линий/маркеров и размер подписей осей —
// пропорции (углы/раскладка) не менялись, только масштаб (см. axisAngle/pointAt
// ниже — те же формулы, просто больше константы).
const WIDTH = 480;
const HEIGHT = 420;
const CENTER = { x: 232, y: 200 };
const RADIUS = 152;
const RINGS = [2, 4, 6, 8, 10];

function axisAngle(i: number, n: number): number {
  return (-90 + i * (360 / n)) * (Math.PI / 180);
}

function pointAt(i: number, n: number, value: number, r = RADIUS): { x: number; y: number } {
  const rr = r * (Math.max(0, Math.min(10, value)) / 10);
  const a = axisAngle(i, n);
  return { x: CENTER.x + rr * Math.cos(a), y: CENTER.y + rr * Math.sin(a) };
}

function polygonPoints(values: number[]): string {
  return values.map((v, i) => { const p = pointAt(i, values.length, v); return `${p.x.toFixed(1)},${p.y.toFixed(1)}`; }).join(' ');
}

function labelAnchor(x: number): 'start' | 'middle' | 'end' {
  if (x > CENTER.x + 6) return 'start';
  if (x < CENTER.x - 6) return 'end';
  return 'middle';
}

export function ManagerCardRadar({ axes }: { axes: RadarAxisInput[] }) {
  const n = axes.length;
  const periodValues     = axes.map(a => a.dataAvailable ? (a.periodValue ?? 0) : 0);
  const comparisonValues = axes.map(a => a.dataAvailable ? (a.comparisonValue ?? 0) : 0);
  const anyMissing = axes.some(a => !a.dataAvailable);

  return (
    <div className="flex flex-col items-center">
      <svg width={WIDTH} height={HEIGHT} viewBox={`0 0 ${WIDTH} ${HEIGHT}`}>
        {/* Сетка колец — толщина увеличена вместе с холстом (карточка v4, п.3) */}
        {RINGS.map(ring => (
          <polygon
            key={ring}
            points={polygonPoints(Array(n).fill(ring))}
            fill="none"
            stroke="var(--color-border)"
            strokeWidth={ring === 10 ? 1.6 : 1.2}
          />
        ))}
        {/* Оси */}
        {axes.map((_, i) => {
          const p = pointAt(i, n, 10);
          return <line key={i} x1={CENTER.x} y1={CENTER.y} x2={p.x} y2={p.y} stroke="var(--color-border)" strokeWidth={1.2} />;
        })}

        {/* Слой «период сравнения» (серый пунктир) — задача 10.07, п.3 */}
        <polygon
          points={polygonPoints(comparisonValues)}
          fill="#94a3b8" fillOpacity={0.22} stroke="#94a3b8" strokeWidth={2.2} strokeOpacity={0.7} strokeDasharray="5 4"
        />

        {/* Слой «выбранный период» (синий) — карточка v4: толще (было 2) для
            выразительности на увеличенном холсте */}
        <polygon
          points={polygonPoints(periodValues)}
          fill="var(--color-accent)" fillOpacity={0.22} stroke="var(--color-accent)" strokeWidth={3}
        />
        {axes.map((ax, i) => {
          if (!ax.dataAvailable) return null;
          const p = pointAt(i, n, periodValues[i]);
          return <circle key={ax.key} cx={p.x} cy={p.y} r={4.6} fill="var(--color-accent)" />;
        })}

        {/* Подписи осей — карточка v4, п.3: крупнее и читаемее (было 10.5px,
            владелец: «мелко») */}
        {axes.map((ax, i) => {
          const p = pointAt(i, n, 13.2);
          const anchor = labelAnchor(p.x);
          const dy = i === 0 ? 2 : Math.abs(p.y - CENTER.y) < 4 ? 4 : 0;
          return (
            <text
              key={ax.key}
              x={p.x} y={p.y + dy}
              textAnchor={anchor}
              fontSize={13.5} fontWeight={700}
              fill="var(--color-text-muted)"
              fontFamily="-apple-system, Arial, sans-serif"
            >
              {ax.label}{!ax.dataAvailable ? '*' : ''}
            </text>
          );
        })}
      </svg>
      <div className="flex items-center gap-5 mt-0.5 text-[12.5px] text-[var(--color-text-muted)]">
        <span className="flex items-center gap-1.5">
          <span className="w-3.5 h-3.5 rounded-[4px]" style={{ backgroundColor: 'var(--color-accent)', opacity: 0.85 }} />
          Выбранный период
        </span>
        <span className="flex items-center gap-1.5">
          <span className="w-3.5 h-3.5 rounded-[4px]" style={{ backgroundColor: '#94a3b8', opacity: 0.55 }} />
          Период сравнения
        </span>
      </div>
      {anyMissing && (
        <div className="mt-1 text-[11px] text-[var(--color-text-muted)]">* нет данных за период</div>
      )}
    </div>
  );
}
