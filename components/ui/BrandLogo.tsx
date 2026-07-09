// Знак «Монолитика» — «М-барчарт»: три вертикальных pill-столбика (скруглённые
// с обеих сторон), крайние высокие, средний ниже. Цвета — стадии сделок из
// entity-colors (lib/metrics/entity-colors.ts): продажи (синий) / отказы
// (красный) / отгрузки (зелёный). Геометрия повторяет утверждённый эталон
// владельца («Исполнение 1 — цвета стадий», 64px): ширина столбика : зазор :
// высота высокого : высота среднего ≈ 6 : 3 : 17 : 10, радиус = половина
// ширины столбика (полная «таблетка»).
export function BrandLogo({ size = 20, className }: { size?: number; className?: string }) {
  const h = size;
  const w = (size * 24) / 17;
  return (
    <svg
      width={w}
      height={h}
      viewBox="0 0 24 17"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-hidden="true"
    >
      {/* Продажи — синий */}
      <rect x="0" y="0" width="6" height="17" rx="3" fill="#3b82f6" />
      {/* Отказы — красный (низкий средний столбик) */}
      <rect x="9" y="7" width="6" height="10" rx="3" fill="#ef4444" />
      {/* Отгрузки — зелёный */}
      <rect x="18" y="0" width="6" height="17" rx="3" fill="#22c55e" />
    </svg>
  );
}
