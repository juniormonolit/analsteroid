import type Sharp from 'sharp';
import { randomBytes } from 'crypto';
import { redisReady } from '@/lib/cache/redis';
import { fmtMoney } from './text';
import type { HowAreWeFacts, PaceCurve } from './facts';

// ── Дайджест «Как дела?» — картинка ──────────────────────────────────────────
//
// Битрикс показывает превью картинки из ATTACH по публичному URL, поэтому график
// рисуем сами: SVG → PNG через sharp (уже в проекте, на проде есть DejaVu Sans —
// кириллица и стрелки проверены 15.09). Без браузера и тяжёлых зависимостей.
// PNG кладём в Redis под одноразовым токеном (72 ч) — ровно на срок, пока
// Битрикс скачает и закэширует превью; отдаёт /api/how-are-we/chart/[token].

const FONT = "'DejaVu Sans', 'Helvetica Neue', Arial, sans-serif";
const C = {
  bg: '#ffffff', text: '#1f2937', muted: '#6b7280', grid: '#e5e7eb',
  plan: '#e5e7eb', usual: '#374151', ahead: '#2e7d32', behind: '#c62828', normal: '#2563eb',
  typical: '#9ca3af', factLine: '#2563eb', planLine: '#111827',
};
const W = 1200;

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const pctS = (v: number) => `${Math.round(v)} %`;

function text(x: number, y: number, s: string, opts: { size?: number; weight?: number; fill?: string; anchor?: 'start' | 'middle' | 'end' } = {}) {
  return `<text x="${x}" y="${y}" font-family="${FONT}" font-size="${opts.size ?? 22}" font-weight="${opts.weight ?? 400}" fill="${opts.fill ?? C.text}" text-anchor="${opts.anchor ?? 'start'}">${esc(s)}</text>`;
}

/** Панель 1: горизонтальные полосы — факт к часу на фоне дневного плана, засечка «обычно». */
function barsPanel(f: HowAreWeFacts, y0: number): { svg: string; height: number } {
  const rows = [f.company, ...f.branches.filter(b => b.plan || b.sales.n || b.usual.n)];
  const rowH = 74; const labelW = 230; const barX = labelW + 20; const barW = W - barX - 330;
  const max = Math.max(...rows.map(r => Math.max(r.plan ?? 0, r.sales.amt, r.usual.amt)), 1);
  const sx = (v: number) => barX + (v / max) * barW;
  const parts: string[] = [];
  parts.push(text(40, y0, `Продажи к ${String(f.cutHour).padStart(2, '0')}:00 — факт, дневной план и обычный уровень к этому часу`, { size: 22, weight: 700 }));
  let y = y0 + 30;
  for (const r of rows) {
    const ratio = r.usual.amt > 1e4 ? r.sales.amt / r.usual.amt : 1;
    const col = ratio >= 1.15 ? C.ahead : ratio <= 0.85 ? C.behind : C.normal;
    const plan = r.plan ?? 0;
    parts.push(text(40, y + 34, r.name, { size: 24, weight: r.key === 'company' ? 700 : 500 }));
    parts.push(`<rect x="${barX}" y="${y + 12}" width="${Math.max(2, sx(plan) - barX)}" height="34" rx="6" fill="${C.plan}"/>`);
    parts.push(`<rect x="${barX}" y="${y + 12}" width="${Math.max(2, sx(r.sales.amt) - barX)}" height="34" rx="6" fill="${col}"/>`);
    if (r.usual.amt > 0) {
      const ux = sx(r.usual.amt);
      parts.push(`<line x1="${ux}" y1="${y + 4}" x2="${ux}" y2="${y + 54}" stroke="${C.usual}" stroke-width="3" stroke-dasharray="5 4"/>`);
    }
    const p = plan > 0 ? pctS(r.sales.amt / plan * 100) : '—';
    parts.push(text(barX + barW + 20, y + 30, `${fmtMoney(r.sales.amt)} из ${plan ? fmtMoney(plan) : '—'} · ${p}`, { size: 22, weight: 600 }));
    parts.push(text(barX + barW + 20, y + 54, `обычно ${fmtMoney(r.usual.amt)}`, { size: 18, fill: C.muted }));
    y += rowH;
  }
  // Легенда.
  parts.push(`<rect x="${barX}" y="${y + 10}" width="26" height="14" rx="3" fill="${C.plan}"/>` + text(barX + 34, y + 22, 'план дня', { size: 17, fill: C.muted }));
  parts.push(`<rect x="${barX + 150}" y="${y + 10}" width="26" height="14" rx="3" fill="${C.normal}"/>` + text(barX + 184, y + 22, 'факт (зелёный — выше обычного, красный — ниже)', { size: 17, fill: C.muted }));
  parts.push(`<line x1="${barX + 640}" y1="${y + 8}" x2="${barX + 640}" y2="${y + 28}" stroke="${C.usual}" stroke-width="3" stroke-dasharray="5 4"/>` + text(barX + 652, y + 22, 'обычно к этому часу', { size: 17, fill: C.muted }));
  return { svg: parts.join(''), height: y + 40 - y0 };
}

/** Панель 2 (вечер): накопленный факт месяца против плана и типичного темпа. */
function pacePanel(title: string, curve: PaceCurve, plan: number, workdayNum: number, days: number, y0: number): { svg: string; height: number } {
  const H = 300; const left = 130; const right = W - 60; const top = y0 + 44; const bottom = y0 + H - 40;
  const max = Math.max(plan, curve.fact[curve.fact.length - 1] ?? 0, 1) * 1.05;
  const sx = (n: number) => left + ((n - 1) / Math.max(1, days - 1)) * (right - left);
  const sy = (v: number) => bottom - (v / max) * (bottom - top);
  const parts: string[] = [];
  parts.push(text(40, y0 + 22, title, { size: 22, weight: 700 }));
  // Сетка и подписи оси Y (4 линии).
  for (let i = 0; i <= 4; i++) {
    const v = max / 4 * i; const y = sy(v);
    parts.push(`<line x1="${left}" y1="${y}" x2="${right}" y2="${y}" stroke="${C.grid}" stroke-width="1"/>`);
    parts.push(text(left - 12, y + 6, fmtMoney(v), { size: 16, fill: C.muted, anchor: 'end' }));
  }
  // Ось X — рабочие дни.
  for (let n = 1; n <= days; n++) if (n === 1 || n % 5 === 0 || n === days) parts.push(text(sx(n), bottom + 26, String(n), { size: 16, fill: C.muted, anchor: 'middle' }));
  parts.push(text(left, bottom + 50, 'рабочий день месяца', { size: 16, fill: C.muted }));
  // План — прямая до 100 %.
  if (plan > 0) parts.push(`<line x1="${sx(1)}" y1="${sy(plan / days)}" x2="${sx(days)}" y2="${sy(plan)}" stroke="${C.planLine}" stroke-width="2" stroke-dasharray="8 6"/>`);
  // Типичный темп — доля × план.
  if (plan > 0) {
    const pts = curve.typical.map((s, i) => s == null ? null : `${sx(i + 1)},${sy(s * plan)}`).filter(Boolean);
    if (pts.length > 1) parts.push(`<polyline points="${pts.join(' ')}" fill="none" stroke="${C.typical}" stroke-width="3"/>`);
  }
  // Факт.
  const fp = curve.fact.map((v, i) => `${sx(i + 1)},${sy(v)}`);
  if (fp.length > 1) parts.push(`<polyline points="${fp.join(' ')}" fill="none" stroke="${C.factLine}" stroke-width="4"/>`);
  if (fp.length) {
    const last = curve.fact[curve.fact.length - 1];
    parts.push(`<circle cx="${sx(workdayNum)}" cy="${sy(last)}" r="7" fill="${C.factLine}"/>`);
    parts.push(text(sx(workdayNum) + (workdayNum > days * 0.75 ? -14 : 14), sy(last) - 14, fmtMoney(last), { size: 18, weight: 700, fill: C.factLine, anchor: workdayNum > days * 0.75 ? 'end' : 'start' }));
  }
  // Легенда — внизу справа, чтобы не наезжать на длинный заголовок панели.
  const ly = bottom + 50; const lx = right - 560;
  parts.push(`<line x1="${lx}" y1="${ly - 6}" x2="${lx + 40}" y2="${ly - 6}" stroke="${C.factLine}" stroke-width="4"/>` + text(lx + 48, ly, 'факт', { size: 16, fill: C.muted }));
  parts.push(`<line x1="${lx + 130}" y1="${ly - 6}" x2="${lx + 170}" y2="${ly - 6}" stroke="${C.typical}" stroke-width="3"/>` + text(lx + 178, ly, 'обычный темп', { size: 16, fill: C.muted }));
  parts.push(`<line x1="${lx + 340}" y1="${ly - 6}" x2="${lx + 380}" y2="${ly - 6}" stroke="${C.planLine}" stroke-width="2" stroke-dasharray="8 6"/>` + text(lx + 388, ly, 'план', { size: 16, fill: C.muted }));
  return { svg: parts.join(''), height: H + 20 };
}

export function buildHowAreWeSvg(f: HowAreWeFacts): string {
  const d = new Date(`${f.dateStr}T00:00:00Z`);
  const MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
  const body: string[] = [];
  let y = 60;
  body.push(text(40, y, `Как дела? · ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}, ${String(f.cutHour).padStart(2, '0')}:00`, { size: 30, weight: 700 }));
  y += 50;
  const bars = barsPanel(f, y); body.push(bars.svg); y += bars.height + 20;
  if (f.month) {
    const s = pacePanel(`Продажи месяца: ${pctS((f.month.company.sales.share ?? 0) * 100)} плана к ${f.month.workdayNum}-му рабочему дню из ${f.month.workdaysInMonth}`,
      f.month.company.curves.sales, f.month.company.sales.plan, f.month.workdayNum, f.month.workdaysInMonth, y);
    body.push(s.svg); y += s.height;
    const sh = pacePanel(`Отгрузки месяца: ${pctS((f.month.company.shipments.share ?? 0) * 100)} плана`,
      f.month.company.curves.shipments, f.month.company.shipments.plan, f.month.workdayNum, f.month.workdaysInMonth, y);
    body.push(sh.svg); y += sh.height;
  }
  const H = y + 20;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><rect width="${W}" height="${H}" fill="${C.bg}"/>${body.join('')}</svg>`;
}

// sharp — нативный модуль; статический импорт ломает сборку Edge-варианта
// instrumentation (цепочка instrumentation → jobs/howAreWe → chart). Поэтому
// грузим его только в рантайме Node, мимо бандлера.
async function loadSharp(): Promise<typeof Sharp> {
  const mod = await import(/* webpackIgnore: true */ /* turbopackIgnore: true */ 'sharp');
  return (mod.default ?? mod) as typeof Sharp;
}

export async function renderHowAreWePng(f: HowAreWeFacts): Promise<Buffer> {
  const sharp = await loadSharp();
  return sharp(Buffer.from(buildHowAreWeSvg(f)), { density: 96 }).png({ compressionLevel: 9 }).toBuffer();
}

const IMG_TTL_SEC = 72 * 3600;
const key = (token: string) => `how-are-we:img:${token}`;

/** Сохранить PNG под одноразовым токеном; null — Redis недоступен (шлём без картинки). */
export async function storeChart(png: Buffer): Promise<string | null> {
  const r = await redisReady();
  if (!r) return null;
  const token = randomBytes(16).toString('hex');
  try { await r.set(key(token), png.toString('base64'), 'EX', IMG_TTL_SEC); } catch { return null; }
  return token;
}

export async function loadChart(token: string): Promise<Buffer | null> {
  if (!/^[a-f0-9]{32}$/.test(token)) return null;
  const r = await redisReady();
  if (!r) return null;
  const v = await r.get(key(token)).catch(() => null);
  return v ? Buffer.from(v, 'base64') : null;
}
