type DataType = 'int' | 'decimal' | 'money' | 'percent' | 'months';

const ruRU = 'ru-RU';

export function formatValue(value: number | null | undefined, dataType: DataType, decimalPlaces = 0): string {
  if (value === null || value === undefined) return '—';
  switch (dataType) {
    case 'money':
      return new Intl.NumberFormat(ruRU, {
        style: 'currency', currency: 'RUB',
        maximumFractionDigits: 0, minimumFractionDigits: 0,
      }).format(value);
    case 'percent':
      return new Intl.NumberFormat(ruRU, {
        style: 'percent',
        minimumFractionDigits: 1, maximumFractionDigits: 1,
      }).format(value / 100);
    case 'int':
      return new Intl.NumberFormat(ruRU, { maximumFractionDigits: 0 }).format(value);
    case 'decimal':
      return new Intl.NumberFormat(ruRU, {
        minimumFractionDigits: decimalPlaces,
        maximumFractionDigits: decimalPlaces,
      }).format(value);
    case 'months':
      return new Intl.NumberFormat(ruRU, {
        minimumFractionDigits: decimalPlaces,
        maximumFractionDigits: decimalPlaces,
      }).format(value);
  }
}

export function formatDelta(delta: number | null | undefined, dataType: DataType, decimalPlaces = 0): string {
  if (delta === null || delta === undefined) return '—';
  const prefix = delta > 0 ? '+' : '';
  return prefix + formatValue(delta, dataType, decimalPlaces);
}

export function formatDeltaPct(deltaPct: number | null | undefined): string {
  if (deltaPct === null || deltaPct === undefined) return '—';
  if (!isFinite(deltaPct)) return deltaPct > 0 ? '+∞' : '−∞';
  const prefix = deltaPct > 0 ? '+' : '';
  return prefix + new Intl.NumberFormat(ruRU, {
    minimumFractionDigits: 1, maximumFractionDigits: 1,
  }).format(deltaPct) + '%';
}
