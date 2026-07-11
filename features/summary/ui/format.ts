export function fmtMoney(n: number): string {
  return n.toLocaleString('ru-RU', { maximumFractionDigits: 0 });
}

export function fmtInt(n: number): string {
  return n.toLocaleString('ru-RU');
}

export function fmtPct(n: number | null, decimals = 1): string {
  return n === null ? '—' : `${n.toLocaleString('ru-RU', { maximumFractionDigits: decimals })}%`;
}

export function fmtUpdatedAt(iso: string): string {
  return new Date(iso).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

// ── Переходы в полные отчёты (бриф 1704, п.3: «каждый блок кликабелен») ──────────
// UUID — конкретные общие отчёты (saved_reports, is_shared=true), сняты живым запросом
// к system.saved_reports 11.07 (owners-inbox брифа задачи, база одна и та же и на
// проде, и здесь — id стабильны). Захардкожено сознательно: страница «Сводная» и так
// уже завязана на конкретную орг-структуру (филиалы Россия/КРД/МСК/СПБ), общие отчёты
// того же порядка стабильности.
export const REPORT_LINKS = {
  managers: '/sales/saved/b7589b92-8d98-4e54-8c56-004e49deb40e',       // «Менеджеры» (Смекалочная)
  conversions: '/sales/saved/a72c4750-f0af-42df-96f3-54534058bfe3',    // «Менеджер - Конверсии» (Смекалочная)
  ropMonitor: '/sales/saved/4d82d6f0-a67e-4983-8fbb-9920c1158d00',     // «Базовый минимум» (РОП монитор)
  plans: '/plans',
} as const;
