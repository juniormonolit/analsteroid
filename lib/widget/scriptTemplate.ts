// Шаблон самодостаточного Scriptable-скрипта. Сервер подставляет __WIDGET_TOKEN__ и
// __BASE_URL__ (buildWidgetScript ниже) и шлёт пользователю одним сообщением через бота.
// Здесь — ТОЛЬКО плейсхолдеры, без реального секрета (файл коммитится).
//
// Рендер (переработка 17.07 по фидбеку владельца + референсы):
//  - план/факт — ОДНО кольцо «выполнение плана»: заполнение дуги = %, в центре короткий
//    «84%» (всегда влезает), под ним мелко «факт / план»;
//  - абсолютные ₽ — только год: в центре компактное «15,1 млрд», шрифт АДАПТИВНЫЙ
//    (считается от длины строки — «не помещаются в кружочки» больше невозможно);
//  - акцентный цвет и тема (тёмная/светлая) — из конфига (кастомизация в конструкторе);
//  - стиль — референс: тонкое кольцо, скруглённые концы, крупное число, приглушённая подпись.
// Все цвета в DrawContext фиксированные (Color.dynamic в битмапе не резолвится — известно).
const TEMPLATE = String.raw`
const TOKEN = "__WIDGET_TOKEN__";
const BASE_URL = "__BASE_URL__";

const CACHE_FILE = "widget_custom_cache_" + (args.widgetParameter || "default") + ".json";
const fm = FileManager.local();
const cachePath = () => fm.joinPath(fm.documentsDirectory(), CACHE_FILE);
function loadCache() { try { return JSON.parse(fm.readString(cachePath())); } catch { return null; } }
function saveCache(d) { try { fm.writeString(cachePath(), JSON.stringify(d)); } catch {} }

const family = config.widgetFamily || "medium";
const param = args.widgetParameter || "";

async function fetchSlice() {
  const url = BASE_URL + "/api/widget-metrics/custom?token=" + encodeURIComponent(TOKEN)
    + "&family=" + encodeURIComponent(family) + "&param=" + encodeURIComponent(param);
  const req = new Request(url); req.timeoutInterval = 10;
  const data = await req.loadJSON();
  if (req.response.statusCode !== 200) throw new Error((data && data.error) || ("HTTP " + req.response.statusCode));
  return data;
}

const LABEL = {
  sales_completion: "план продаж", shipments_completion: "план отгрузок",
  fact_sales: "продажи", fact_shipments: "отгрузки",
  cr_sale: "CR в продажу", cr_shipment: "CR в отгрузку",
};

// ── Тема ──────────────────────────────────────────────────────────────
function makeTheme(colors) {
  const dark = !colors || colors.theme !== "light";
  return {
    bgTop: new Color(dark ? "#1b1d26" : "#ffffff"),
    bgBottom: new Color(dark ? "#13141b" : "#eef0f5"),
    track: new Color(dark ? "#ffffff20" : "#00000012"),
    text: new Color(dark ? "#ffffff" : "#1a1b26"),
    muted: new Color(dark ? "#9aa0ad" : "#6b7280"),
    accent: new Color((colors && colors.accent) || (dark ? "#ffffff" : "#1a73e8")),
  };
}

function fmtMoney(n) {
  if (n == null) return "—";
  const a = Math.abs(n);
  const f = (x, s) => (x.toFixed(1).replace(".", ",").replace(",0", "")) + s;
  if (a >= 1e9) return f(n / 1e9, " млрд");
  if (a >= 1e6) return f(n / 1e6, " млн");
  if (a >= 1e3) return Math.round(n / 1e3) + " тыс";
  return String(Math.round(n));
}
function fmtMoneyShort(n) {
  if (n == null) return "—";
  const a = Math.abs(n);
  const f = x => x.toFixed(1).replace(".", ",").replace(",0", "");
  if (a >= 1e9) return f(n / 1e9);
  if (a >= 1e6) return f(n / 1e6);
  return String(Math.round(n / 1e3));
}
function fmtPct(n) { return n == null ? "—" : Math.round(n) + "%"; }

// Адаптивный кегль: текст обязан влезть во внутренний диаметр кольца.
function fitFont(text, innerWidth, maxSize) {
  const est = Math.max(1, text.length) * 0.56; // ~ширина глифа SF Bold в долях кегля
  return Math.max(10, Math.min(maxSize, innerWidth / est));
}

// Кольцо в стиле референса: тонкий трек, накат с закруглёнными концами, центр —
// главное число (адаптивный кегль) + опциональная мелкая строка под ним.
function ringImage(T, size, lineW, fillPct, centerText, subText) {
  const ctx = new DrawContext(); ctx.size = new Size(size, size); ctx.opaque = false; ctx.respectScreenScale = true;
  const cx = size / 2, cy = size / 2, r = (size - lineW) / 2;
  function arc(frac, color) {
    const steps = Math.max(2, Math.round(360 * Math.max(frac, 0.001)));
    const path = new Path(); let first = true;
    for (let i = 0; i <= steps; i++) {
      const deg = -90 + 360 * frac * (i / steps); const rad = deg * Math.PI / 180;
      const p = new Point(cx + r * Math.cos(rad), cy + r * Math.sin(rad));
      if (first) { path.move(p); first = false; } else path.addLine(p);
    }
    ctx.setStrokeColor(color); ctx.setLineWidth(lineW); ctx.addPath(path); ctx.strokePath();
  }
  arc(1, T.track);
  const frac = fillPct == null ? 0 : Math.max(0.02, Math.min(1, fillPct / 100));
  if (fillPct != null) {
    arc(frac, T.accent);
    const cap = lineW / 2;
    for (const deg of [-90, -90 + 360 * frac]) {
      const rad = deg * Math.PI / 180; const p = new Point(cx + r * Math.cos(rad), cy + r * Math.sin(rad));
      ctx.setFillColor(T.accent); ctx.fillEllipse(new Rect(p.x - cap, p.y - cap, cap * 2, cap * 2));
    }
  }
  const innerW = (size - lineW * 4) * 0.92;
  const mainSize = fitFont(centerText, innerW, size * 0.24);
  ctx.setTextAlignedCenter();
  const hasSub = !!subText && size >= 88;
  const mainY = hasSub ? cy - mainSize * 0.75 : cy - mainSize * 0.62;
  ctx.setFont(Font.boldSystemFont(mainSize)); ctx.setTextColor(T.text);
  ctx.drawTextInRect(centerText, new Rect(0, mainY, size, mainSize * 1.3));
  if (hasSub) {
    const subSize = Math.max(8, Math.min(10, fitFont(subText, innerW, 10)));
    ctx.setFont(Font.mediumSystemFont(subSize)); ctx.setTextColor(T.muted);
    ctx.drawTextInRect(subText, new Rect(0, cy + mainSize * 0.42, size, subSize * 1.4));
  }
  return ctx.getImage();
}

// item → параметры кольца
function ringParams(it) {
  if (it.kind === "completion") {
    const sub = it.plan != null ? (fmtMoneyShort(it.fact) + " / " + fmtMoney(it.plan)) : null;
    return { fill: it.value, center: fmtPct(it.value), sub };
  }
  if (it.kind === "money") {
    const fill = it.plan != null && it.plan > 0 ? (it.fact / it.plan) * 100 : null;
    const sub = it.plan != null ? ("план " + fmtMoney(it.plan)) : null;
    return { fill, center: fmtMoney(it.value), sub };
  }
  return { fill: it.value, center: it.value == null ? "—" : (Math.round(it.value * 10) / 10 + "%").replace(".", ","), sub: null };
}

function buildWidget(slice, stale) {
  const T = makeTheme(slice.colors);
  const w = new ListWidget();
  const g = new LinearGradient(); g.colors = [T.bgTop, T.bgBottom]; g.locations = [0, 1]; w.backgroundGradient = g;
  w.url = BASE_URL + "/widget-constructor";
  w.setPadding(12, 14, 10, 14);
  w.refreshAfterDate = new Date(Date.now() + 12 * 60 * 1000);

  const items = slice.values;
  const maxN = family === "small" ? 1 : family === "medium" ? 2 : 4;
  const shown = items.slice(0, maxN);
  const ringSize = family === "small" ? 104 : family === "medium" ? 92 : 104;
  const lineW = Math.round(ringSize * 0.085);

  const header = w.addStack(); header.layoutHorizontally(); header.centerAlignContent();
  const title = header.addText(slice.scope_name || "");
  title.font = Font.mediumSystemFont(11); title.textColor = T.muted; title.lineLimit = 1;
  header.addSpacer();
  if (stale) { const st = header.addText("⚠"); st.font = Font.systemFont(10); st.textColor = T.muted; }

  w.addSpacer();

  const rows = family === "large" && shown.length > 2 ? [shown.slice(0, 2), shown.slice(2)] : [shown];
  for (let ri = 0; ri < rows.length; ri++) {
    const row = w.addStack(); row.layoutHorizontally(); row.centerAlignContent(); row.addSpacer();
    for (let i = 0; i < rows[ri].length; i++) {
      const it = rows[ri][i];
      const p = ringParams(it);
      const col = row.addStack(); col.layoutVertically();
      const img = col.addStack(); img.layoutHorizontally(); img.addSpacer();
      img.addImage(ringImage(T, ringSize, lineW, p.fill, p.center, p.sub));
      img.addSpacer();
      col.addSpacer(5);
      const capRow = col.addStack(); capRow.layoutHorizontally(); capRow.addSpacer();
      const cap = capRow.addText(LABEL[it.id] || it.id);
      cap.font = Font.mediumSystemFont(10); cap.textColor = T.muted; cap.lineLimit = 1;
      capRow.addSpacer();
      if (i < rows[ri].length - 1) row.addSpacer(18);
    }
    row.addSpacer();
    if (ri < rows.length - 1) w.addSpacer(10);
  }

  w.addSpacer();
  const foot = w.addText("обновлено " + (slice.updated_at || "").slice(11, 16));
  foot.font = Font.systemFont(8); foot.textColor = T.muted; foot.centerAlignText();
  return w;
}

let slice, stale = false;
try { slice = await fetchSlice(); saveCache(slice); }
catch (e) { slice = loadCache(); if (!slice) throw e; stale = true; }

const widget = buildWidget(slice, stale);
Script.setWidget(widget);
if (!config.runsInWidget) { if (family === "small") await widget.presentSmall(); else if (family === "large") await widget.presentLarge(); else await widget.presentMedium(); }
Script.complete();
`;

export function buildWidgetScript(token: string, baseUrl: string): string {
  return TEMPLATE
    .replace(/__WIDGET_TOKEN__/g, token)
    .replace(/__BASE_URL__/g, baseUrl)
    .trimStart();
}
