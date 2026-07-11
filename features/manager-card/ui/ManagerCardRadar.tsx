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
// пропорции (углы/раскладка) паутины САМОЙ не менялись, только масштаб.
// RADIUS ниже — это радиус паутины (кольца/спицы/данные), его не трогаем.
const RADIUS = 152;
const RINGS = [2, 4, 6, 8, 10];

// Задача 1608 (владелец, скрин): подписи осей обрезались боковыми краями
// холста — при укрупнении (2d89d53) холст остался 480×420, а подписи метрик
// каталога (~195 штук, до 59 символов, напр. «Длительность первого разговора
// сделки, мин, медиана (повт.)») этого не учитывали. Плюс отдельный баг:
// точка подписи считалась как pointAt(i, n, 13.2) — но pointAt клампит value
// к 10, так что «13.2» тихо схлопывалось обратно к радиусу 152 (подпись
// садилась ПРЯМО НА внешнее кольцо, а не за ним).
//
// Фикс — три части:
//  (а) подписи считаются от LABEL_RADIUS (кольцо 10 + небольшой зазор), не от
//      клампнутого pointAt — см. axisAngle/LABEL_RADIUS ниже;
//  (б) подписи, которым не хватает места по факту ширины (см. ниже), —
//      переносятся на 2 строки (tspan), перенос — сбалансированный по словам
//      (wrapLabel);
//  (в) итоговые width/height/CENTER холста считаются ДИНАМИЧЕСКИ по
//      фактическим подписям текущей карточки (computeLayout) — короткие
//      подписи (обычный случай) дают холст как раньше (480×420, floor-константы
//      ниже равны исходным CENTER/WIDTH/HEIGHT), длинные — раздвигают поля
//      настолько, насколько нужно именно этому набору осей. Экстремальный
//      потолок (MAX_HALF_W/H) — защита от неограниченного разрастания;
//      если когда-нибудь в каталоге появится метрика длиннее — контейнер
//      ManagerCardPanel.tsx уже рендерит паутину в блоке с overflow-x-auto,
//      так что вместо обрезки текста будет горизонтальный скролл.
//
// Задача 1692 (Серёга, кейс 7Б аудита): на 1440px правая колонка панели
// (`ManagerCardPanel.tsx`, grid-колонка ~520px) оказалась уже, чем
// однострочные подписи «Сумма продаж»/«Средний чек» требовали от canvas
// (272/263px против FLOOR_RIGHT=248) — сам SVG их не обрезал (computeLayout
// динамически раздвигал canvas), но панель-контейнер (`overflow-x-auto` +
// `flex justify-center`) при переполнении центрирует лишнюю ширину поровну
// на обе стороны, и «вылезающий» кусок справа зрительно обрезался (виден не
// весь SVG, а окно контейнера — воспроизведено пуппетером, замер
// `outerBox.clientWidth` vs `svg width`, см. WORKLOG). До этой задачи
// решался только один частный случай — перенос
// по числу символов (`length > 22`), поэтому «Сумма продаж»/«Средний чек»
// (12/11 симв.) его не проходили и оставались в одну строку.
//
// Критерий переноса ПЕРЕРАБОТАН на факт: не число символов, а оценка
// ширины строки БЕЗ переноса плюс её позиция на паутине (та же формула,
// что computeLayout использует для роста canvas — dx/anchor/SIDE_BUFFER)
// сравнивается с "полом" канвы на соответствующей стороне (FLOOR_LEFT/
// FLOOR_RIGHT — исходный бюджет 480×420, рассчитанный на короткие подписи).
// Если однострочный вариант этот бюджет превышает — подпись переносится на
// 2 строки, вне зависимости от того, как называется ось: работает для ЛЮБОЙ
// из ~195 метрик каталога card_templates, а не для конкретных строк.
const LABEL_RADIUS = RADIUS + 18;
const CHAR_PX = 8.9;      // эмпирика: bold 13.5px "-apple-system, Arial, sans-serif", кириллица (puppeteer getBBox по каталогу метрик, см. WORKLOG задача 1608)
const LINE_HEIGHT = 15.5;
const SIDE_BUFFER = 18;
const TOP_BUFFER = 10;
// Floor'ы холста — РАВНЫ исходным WIDTH/HEIGHT/CENTER (480×420, центр 232×200):
// при коротких подписях (обычный случай, легаси-оси и большинство каталога)
// раскладка пиксель-в-пиксель совпадает с тем, что было до фикса.
const FLOOR_LEFT = 232;
const FLOOR_RIGHT = 248;
const FLOOR_TOP = 200;
const FLOOR_BOTTOM = 220;
const MAX_HALF_W = 480; // защитный потолок по горизонтали (итоговая ширина максимум ~960)
const MAX_HALF_H = 260; // защитный потолок по вертикали

function axisAngle(i: number, n: number): number {
  return (-90 + i * (360 / n)) * (Math.PI / 180);
}

// Сбалансированный перенос на 2 строки: перебирает все точки разрыва по
// словам, выбирает ту, что минимизирует длину ДЛИННЕЙШЕЙ из двух строк
// (а не просто "жадно заполнить первую строку") — так «Длительность первого
// разговора сделки, мин, медиана (повт.)» (59 симв.) не превращается в одну
// длинную и один короткий хвост, а делится ~30/29. Решение О ТОМ, переносить
// ли вообще, — за пределами этой функции (см. needsWrap ниже); сама
// wrapLabel просто строит лучший 2-строчный вариант для переданной строки.
function wrapLabel(label: string): string[] {
  const words = label.split(' ');
  if (words.length < 2) return [label]; // одно длинное слово — переносить некуда
  let best: { l1: string; l2: string; maxLen: number } | null = null;
  for (let i = 1; i < words.length; i++) {
    const l1 = words.slice(0, i).join(' ');
    const l2 = words.slice(i).join(' ');
    const maxLen = Math.max(l1.length, l2.length);
    if (!best || maxLen < best.maxLen) best = { l1, l2, maxLen };
  }
  return best ? [best.l1, best.l2] : [label];
}

function estWidth(text: string): number {
  return text.length * CHAR_PX;
}

// Сколько половины canvas ("пола") реально нужно ОДНОЙ строке текста на этой
// позиции — та же формула, что computeLayout ниже применяет к готовым lines,
// только для гипотетического однострочного варианта. anchor 'middle'
// (верх/низ паутины) тратит на каждую сторону только половину своей ширины
// (текст центрирован на оси), start/end (боковые оси) — dx + ПОЛНУЮ ширину
// (текст растёт в одну сторону от точки привязки).
function singleLineHalfNeed(width: number, dx: number, anchor: LabelGeo['anchor']): number {
  return anchor === 'middle' ? width / 2 + SIDE_BUFFER : Math.abs(dx) + width + SIDE_BUFFER;
}

// Критерий переноса (задача 1692, кейс 7Б) — по фактической ширине/позиции,
// не по списку названий: если однострочный вариант этой подписи ТРЕБУЕТ от
// canvas больше, чем "пол" (FLOOR_LEFT/FLOOR_RIGHT — бюджет, рассчитанный на
// короткие подписи и совпадающий с реальной шириной панели на 1440px, см.
// комментарий выше), — переносим. Работает одинаково для «Сумма продаж»
// (12 симв., раньше не переносилось — не хватало ДЛИНЫ строки) и для
// «Длительность первого разговора...» (59 симв.) — критерий один.
function needsWrap(label: string, dx: number, anchor: LabelGeo['anchor'], suffixWidth: number): boolean {
  if (label.split(' ').length < 2) return false; // переносить некуда
  const need = singleLineHalfNeed(estWidth(label) + suffixWidth, dx, anchor);
  const floorBudget = dx > 0 ? FLOOR_RIGHT : dx < 0 ? FLOOR_LEFT : Math.min(FLOOR_LEFT, FLOOR_RIGHT);
  return need > floorBudget;
}

interface LabelGeo {
  key: string;
  dx: number;             // офсет точки подписи от центра по X (до вставки-внутрь)
  dy0: number;            // офсет точки подписи от центра по Y
  anchor: 'start' | 'middle' | 'end';
  lines: string[];
  lineWidth: number;      // ширина самой широкой строки (оценка)
  extremity: number;      // 0 (вертикальная ось) .. 1 (горизонтальная) — для сдвига-внутрь (в)
}

function buildLabelGeo(axes: RadarAxisInput[]): LabelGeo[] {
  const n = axes.length;
  return axes.map((ax, i) => {
    const a = axisAngle(i, n);
    const cos = Math.cos(a);
    const sin = Math.sin(a);
    const dx = LABEL_RADIUS * cos;
    const dy0 = LABEL_RADIUS * sin;
    const anchor: LabelGeo['anchor'] = dx > 6 ? 'start' : dx < -6 ? 'end' : 'middle';
    const suffix = ax.dataAvailable ? '' : '*';
    const rawLines = needsWrap(ax.label, dx, anchor, estWidth(suffix)) ? wrapLabel(ax.label) : [ax.label];
    const lines = rawLines.map((l, li) => (li === rawLines.length - 1 ? l + suffix : l));
    const lineWidth = Math.max(...lines.map(estWidth));
    return { key: ax.key, dx, dy0, anchor, lines, lineWidth, extremity: Math.min(1, Math.abs(cos)) };
  });
}

function computeLayout(geo: LabelGeo[]) {
  let rightHalf = FLOOR_RIGHT;
  let leftHalf = FLOOR_LEFT;
  let topHalf = FLOOR_TOP;
  let bottomHalf = FLOOR_BOTTOM;

  for (const g of geo) {
    const blockHalfHeight = (g.lines.length * LINE_HEIGHT) / 2 + TOP_BUFFER;

    if (g.anchor === 'start') {
      rightHalf = Math.max(rightHalf, g.dx + g.lineWidth + SIDE_BUFFER);
    } else if (g.anchor === 'end') {
      leftHalf = Math.max(leftHalf, -g.dx + g.lineWidth + SIDE_BUFFER);
    } else {
      rightHalf = Math.max(rightHalf, Math.max(0, g.dx) + g.lineWidth / 2 + SIDE_BUFFER);
      leftHalf = Math.max(leftHalf, Math.max(0, -g.dx) + g.lineWidth / 2 + SIDE_BUFFER);
    }

    topHalf = Math.max(topHalf, blockHalfHeight - g.dy0);
    bottomHalf = Math.max(bottomHalf, blockHalfHeight + g.dy0);
  }

  rightHalf = Math.min(rightHalf, MAX_HALF_W);
  leftHalf = Math.min(leftHalf, MAX_HALF_W);
  topHalf = Math.min(topHalf, MAX_HALF_H);
  bottomHalf = Math.min(bottomHalf, MAX_HALF_H);

  return {
    width: Math.round(leftHalf + rightHalf),
    height: Math.round(topHalf + bottomHalf),
    center: { x: Math.round(leftHalf), y: Math.round(topHalf) },
  };
}

function pointAt(center: { x: number; y: number }, i: number, n: number, value: number, r = RADIUS): { x: number; y: number } {
  const rr = r * (Math.max(0, Math.min(10, value)) / 10);
  const a = axisAngle(i, n);
  return { x: center.x + rr * Math.cos(a), y: center.y + rr * Math.sin(a) };
}

function polygonPoints(center: { x: number; y: number }, values: number[]): string {
  return values.map((v, i) => { const p = pointAt(center, i, values.length, v); return `${p.x.toFixed(1)},${p.y.toFixed(1)}`; }).join(' ');
}

export function ManagerCardRadar({ axes }: { axes: RadarAxisInput[] }) {
  const n = axes.length;
  const periodValues     = axes.map(a => a.dataAvailable ? (a.periodValue ?? 0) : 0);
  const comparisonValues = axes.map(a => a.dataAvailable ? (a.comparisonValue ?? 0) : 0);
  const anyMissing = axes.some(a => !a.dataAvailable);

  const labelGeo = buildLabelGeo(axes);
  const { width, height, center } = computeLayout(labelGeo);

  return (
    <div className="flex flex-col items-center w-full min-w-0">
      {/* Задача 1702 (Серёга, кейс 12А аудита, вариант А): на мобильном (375px)
          холст растёт до десктопной ширины (7Б, computeLayout) и обрезался
          краем карточки — крайние подписи уходили за экран без скролла.

          ВАЖНО (проверено пуппетером до этого фикса): контейнер панели
          (`ManagerCardPanel.tsx`, `.overflow-x-auto`) УЖЕ канвы даже на
          1440px — это и есть штатный вид 7Б (замер: outerBox.clientWidth
          ≈521px vs svg width=573px, `flex justify-center` центрирует
          излишек, левая подпись «висит» на 0.7px за левым краем — owner-
          approved остаточный кейс, не регрессия). Поэтому «width:100% +
          max-width» БЕЗ брейкпоинта здесь не работает — на десктопе он бы
          тоже ужал canvas до ~521px, уменьшив паутину против 7Б-вида.

          Фикс — CSS-переменные + медиа-запрос на реальных 768px (см. <style>
          ниже): на мобильном (<768px) — width:100%/height:auto с потолком
          max-width: canvas-px (не даёт УВЕЛИЧИТЬ паутину сверх штатного
          размера, если контейнер вдруг шире канвы); на ≥768px — жёстко
          canvas-px×canvas-px, как было (никакого CSS-влияния на размер,
          «висящий» излишек и overflow-x-auto — тот же вид, что в 7Б).
          intrinsic width/height/viewBox — как считает computeLayout (полный
          bbox контента, раскладку/перенос не трогаем). min-w-0 — иначе
          flex-item автоминимум (по intrinsic content) не даёт сжаться ниже
          канвы на мобильном. */}
      <style>{`
        .manager-card-radar-svg {
          width: 100%;
          height: auto;
          min-width: 0;
          display: block;
          max-width: var(--radar-canvas-w);
        }
        @media (min-width: 768px) {
          .manager-card-radar-svg {
            width: var(--radar-canvas-w);
            height: var(--radar-canvas-h);
            max-width: none;
          }
        }
      `}</style>
      <svg
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        className="manager-card-radar-svg"
        style={{ '--radar-canvas-w': `${width}px`, '--radar-canvas-h': `${height}px` } as React.CSSProperties}
      >
        {/* Сетка колец — толщина увеличена вместе с холстом (карточка v4, п.3) */}
        {RINGS.map(ring => (
          <polygon
            key={ring}
            points={polygonPoints(center, Array(n).fill(ring))}
            fill="none"
            stroke="var(--color-border)"
            strokeWidth={ring === 10 ? 1.6 : 1.2}
          />
        ))}
        {/* Оси */}
        {axes.map((_, i) => {
          const p = pointAt(center, i, n, 10);
          return <line key={i} x1={center.x} y1={center.y} x2={p.x} y2={p.y} stroke="var(--color-border)" strokeWidth={1.2} />;
        })}

        {/* Слой «период сравнения» (серый пунктир) — задача 10.07, п.3 */}
        <polygon
          points={polygonPoints(center, comparisonValues)}
          fill="#94a3b8" fillOpacity={0.22} stroke="#94a3b8" strokeWidth={2.2} strokeOpacity={0.7} strokeDasharray="5 4"
        />

        {/* Слой «выбранный период» (синий) — карточка v4: толще (было 2) для
            выразительности на увеличенном холсте */}
        <polygon
          points={polygonPoints(center, periodValues)}
          fill="var(--color-accent)" fillOpacity={0.22} stroke="var(--color-accent)" strokeWidth={3}
        />
        {axes.map((ax, i) => {
          if (!ax.dataAvailable) return null;
          const p = pointAt(center, i, n, periodValues[i]);
          return <circle key={ax.key} cx={p.x} cy={p.y} r={4.6} fill="var(--color-accent)" />;
        })}

        {/* Подписи осей — задача 1608: (а) считаются от LABEL_RADIUS, не от
            клампнутого pointAt; (б) длинные — 2 строки через tspan; (в) для
            «боковых» (близких к горизонтали) осей — небольшой сдвиг анчора
            внутрь (extremity), чтобы текст не «зависал» ровно на кончике луча */}
        {axes.map((ax, i) => {
          const g = labelGeo[i];
          const inwardShift = g.anchor === 'middle' ? 0 : g.extremity * 5;
          const textX = center.x + g.dx + (g.anchor === 'start' ? -inwardShift : g.anchor === 'end' ? inwardShift : 0);
          const textY = center.y + g.dy0;
          const singleLineNudge = i === 0 ? 2 : Math.abs(g.dy0) < 4 ? 4 : 0;
          const firstDy = singleLineNudge - ((g.lines.length - 1) * LINE_HEIGHT) / 2;
          return (
            <text
              key={ax.key}
              x={textX} y={textY}
              textAnchor={g.anchor}
              fontSize={13.5} fontWeight={700}
              fill="var(--color-text-muted)"
              fontFamily="-apple-system, Arial, sans-serif"
            >
              {g.lines.map((line, li) => (
                <tspan key={li} x={textX} dy={li === 0 ? firstDy : LINE_HEIGHT}>{line}</tspan>
              ))}
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
