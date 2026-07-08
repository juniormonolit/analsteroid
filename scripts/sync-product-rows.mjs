/**
 * Sync deal product rows from Bitrix for a given month.
 * Usage: node scripts/sync-product-rows.mjs [YYYY-MM]
 * Default: current month.
 * Requires BITRIX_WEBHOOK_2_URL in .env.local (or exported in shell).
 *
 * Rate: 1 batch (50 deals) per 15 sec → ~30 min for 6000 deals.
 */

import pg from 'pg';
import https from 'https';
import fs from 'fs';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
require('@next/env').loadEnvConfig(process.cwd());

const BITRIX_WEBHOOK = (process.env.BITRIX_WEBHOOK_2_URL || '').replace(/\/+$/, '');
if (!BITRIX_WEBHOOK) {
  console.error('BITRIX_WEBHOOK_2_URL не задан');
  process.exit(1);
}
const BATCH_SIZE = 50;
const PAUSE_MS = 15_000;

// ── Category mapping ─────────────────────────────────────────────────────────
// Maps keyword fragments (lowercase) found in product names → catalog category.
// Order matters — first match wins.
const CATEGORY_MAP = [
  // Concrete / solutions
  ['асфальт', 'Асфальт и асфальтобетон'],
  ['щма', 'ЩМА'],
  ['бетон', 'Бетон и раствор'],
  ['раствор', 'Бетон и раствор'],
  // Stone / gravel / sand
  ['щебень', 'Щебень'],
  ['щпс', 'Щебень'],
  ['бутов', 'Щебень'],
  ['отсев', 'Щебень'],
  ['песок', 'Песок'],
  ['пгс', 'Песок'],
  ['грунт', 'Грунт и навоз'],
  ['навоз', 'Грунт и навоз'],
  // Concrete products (ЖБИ)
  ['аэродромн', 'Аэродромные плиты'],
  ['дорожн', 'Дорожные плиты'],
  ['лестничн', 'Лестничные марши и площадки'],
  ['лоток', 'Лотки и плиты лотков ЖБИ'],
  ['плита лотк', 'Лотки и плиты лотков ЖБИ'],
  ['плит перекрыт', 'Плиты перекрытия ЖБИ'],
  ['фбс', 'ФБС'],
  ['кольц', 'Кольца ЖБИ'],
  ['свай', 'Сваи ЖБИ'],
  ['забор жби', 'Заборы ЖБИ'],
  ['трубы жби', 'Трубы ЖБИ'],
  ['труб жби', 'Трубы ЖБИ'],
  ['жби', 'Прочее ЖБИ'],
  ['бпр', 'Прочее ЖБИ'],
  ['опоры св', 'Опоры СВ'],
  ['опора св', 'Опоры СВ'],
  // Masonry
  ['газобетон', 'Газобетон'],
  ['кирпич облиц', 'Облицовочный кирпич'],
  ['кирпич', 'Кирпич и другие стеновые материалы'],
  ['блок стен', 'Кирпич и другие стеновые материалы'],
  // Metals — steel
  ['арматур', 'Арматура стальная и проволока'],
  ['проволок', 'Арматура стальная и проволока'],
  ['сетк', 'Арматура стальная и проволока'],
  ['профил', 'Трубы профильные стальные'],
  ['труб профил', 'Трубы профильные стальные'],
  ['балк', 'Прочий металлопрокат'],
  ['швеллер', 'Прочий металлопрокат'],
  ['уголок', 'Прочий металлопрокат'],
  ['полос', 'Прочий металлопрокат'],
  ['лист горяч', 'Прочий металлопрокат'],
  ['нержав', 'Прочий металлопрокат'],
  ['труб круглых', 'Прочий металлопрокат'],
  ['труб круглые', 'Прочий металлопрокат'],
  // Metals — aluminium / copper
  ['алюмин', 'Цветной металлопрокат'],
  ['медн', 'Цветной металлопрокат'],
  // Piles
  ['свай винт', 'Прочий металлопрокат'],
  ['винтов', 'Прочий металлопрокат'],
  // Timber / boards
  ['брус', 'Пиломатериалы'],
  ['доск', 'Пиломатериалы'],
  ['пиломат', 'Пиломатериалы'],
  ['вагонк', 'Деревянная отделка'],
  ['блок хаус', 'Деревянная отделка'],
  ['имитац бруса', 'Деревянная отделка'],
  ['террасн', 'Деревянная отделка'],
  ['шпунт', 'Деревянная отделка'],
  // Sheet / board materials
  ['осб', 'Плитные материалы'],
  ['osb', 'Плитные материалы'],
  ['оспн', 'Плитные материалы'],
  ['гвл', 'Плитные материалы'],
  ['гипсокартон', 'Плитные материалы'],
  ['дсп', 'Плитные материалы'],
  ['цсп', 'Плитные материалы'],
  // Insulation
  ['технониколь техноакустик', 'Технониколь Техноакустик'],
  ['техноакустик', 'Технониколь Техноакустик'],
  ['технониколь технофас', 'Технониколь Технофас'],
  ['технофас', 'Технониколь Технофас'],
  ['роклайт', 'Теплоизоляция и утеплитель'],
  ['техноблок', 'Теплоизоляция и утеплитель'],
  ['технониколь', 'Теплоизоляция и утеплитель'],
  ['роквул', 'Теплоизоляция и утеплитель'],
  ['кнауф', 'Теплоизоляция и утеплитель'],
  ['пеноплекс', 'Теплоизоляция и утеплитель'],
  ['пеноплэкс', 'Теплоизоляция и утеплитель'],
  ['эппс', 'Теплоизоляция и утеплитель'],
  ['утеплит', 'Теплоизоляция и утеплитель'],
  ['звукоизол', 'Теплоизоляция и утеплитель'],
  // Roofing
  ['металлочерепиц', 'Кровельные материалы, водосточные системы'],
  ['профлист кров', 'Кровельные материалы, водосточные системы'],
  ['черепиц', 'Кровельные материалы, водосточные системы'],
  ['ондулин', 'Ондулин и шифер'],
  ['шифер', 'Ондулин и шифер'],
  ['водосточ', 'Кровельные материалы, водосточные системы'],
  ['гибкая черепиц', 'Кровельные материалы, водосточные системы'],
  // Facade
  ['фасад', 'Фасад'],
  ['сайдинг', 'Фасад'],
  ['вентфасад', 'Фасад'],
  // Fencing / barriers
  ['профлист забор', 'Ограждения и заборы'],
  ['профнастил', 'Ограждения и заборы'],
  ['штакетник', 'Ограждения и заборы'],
  ['сетка гиттер', 'Ограждения и заборы'],
  ['3d сетк', 'Ограждения и заборы'],
  ['ограждени', 'Ограждения и заборы'],
  // Landscaping
  ['тротуарн', 'Изделия для благоустройства'],
  ['бордюр', 'Изделия для благоустройства'],
  ['поребрик', 'Изделия для благоустройства'],
  ['брусчатк', 'Изделия для благоустройства'],
  ['лоток водоотвод', 'Изделия для благоустройства'],
  // Flooring
  ['ламинат', 'Напольные покрытия'],
  ['линолеум', 'Напольные покрытия'],
  // Windows / doors
  ['окн', 'Окна и двери'],
  ['дверь', 'Окна и двери'],
  ['двер', 'Окна и двери'],
  // Dry mixes / cement
  ['цемент', 'Сухие смеси'],
  ['цпс', 'Сухие смеси'],
  ['штукатурк', 'Сухие смеси'],
  ['шпатлевк', 'Сухие смеси'],
  // Waterproofing
  ['гидроизол', 'Рулонная гидроизоляция'],
  ['рубероид', 'Рулонная гидроизоляция'],
  ['геотекстил', 'Геотекстиль'], // not in new list but close enough
  // Paints
  ['краск', 'ЛКМ (Лакокрасочные материалы)'],
  ['лкм', 'ЛКМ (Лакокрасочные материалы)'],
  ['лак', 'ЛКМ (Лакокрасочные материалы)'],
  // Polycarbonate
  ['поликарбонат', 'Изделия из поликарбоната'],
  // Coal / fuel
  ['уголь', 'Уголь'],
  ['угол', 'Уголь'],
  // Seasonal
  ['соль', 'Сезонные товары'],
  ['пескосоль', 'Сезонные товары'],
  ['антигололед', 'Сезонные товары'],
  // Keramsit
  ['керамзит', 'Керамзит'],
  // Sandwich panels
  ['сэндвич', 'Сэндвич-панели'],
  ['сендвич', 'Сэндвич-панели'],
  // Basalt
  ['базальтокартон', 'Базальтокартон'],
  // Delivery / services
  ['доставк', 'Аренда спецтехники'],
  ['перевозк', 'Перевозка'],
  ['аренд', 'Аренда спецтехники'],
  ['экскаватор', 'Аренда спецтехники'],
  ['самосвал', 'Аренда спецтехники'],
];

function classifyProductName(name) {
  const lower = (name || '').toLowerCase();
  for (const [keyword, category] of CATEGORY_MAP) {
    if (lower.includes(keyword)) return category;
  }
  return null; // cannot determine
}

function pickGroupByMax(productRows) {
  if (!productRows || productRows.length === 0) return null;

  // Sum amounts by category
  const totals = new Map();
  const unclassified = [];

  for (const row of productRows) {
    const name = row.PRODUCT_NAME || row.NAME || '';
    const price = parseFloat(row.PRICE || 0);
    const qty = parseFloat(row.QUANTITY || 1);
    const amount = price * qty;
    const cat = classifyProductName(name);

    if (cat) {
      totals.set(cat, (totals.get(cat) || 0) + amount);
    } else {
      unclassified.push({ name, amount });
    }
  }

  if (totals.size === 0) return null;

  let maxCat = null;
  let maxAmt = -1;
  for (const [cat, amt] of totals) {
    if (amt > maxAmt) { maxAmt = amt; maxCat = cat; }
  }
  return maxCat;
}

// ── Bitrix helpers ────────────────────────────────────────────────────────────
function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function bitrixBatch(commands) {
  const params = new URLSearchParams();
  for (const [key, cmd] of Object.entries(commands)) {
    params.append(`cmd[${key}]`, cmd);
  }
  const url = `${BITRIX_WEBHOOK}/batch?${params.toString()}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Bitrix batch HTTP ${res.status}`);
  const json = await res.json();
  return json.result?.result ?? {};
}

// ── DB helpers ────────────────────────────────────────────────────────────────
function createPool() {
  const password = fs.readFileSync('/home/junior/anal_v2/.pg_password', 'utf8').trim();
  return new pg.Pool({
    host: 'rc1b-o2tqrr9j3gq09svq.mdb.yandexcloud.net',
    port: 6432,
    database: 'analytics',
    user: 'JanCloude',
    password,
    ssl: { ca: fs.readFileSync('/home/junior/analsteroid/certs/yandex-ca.pem', 'utf8') },
    max: 3,
  });
}

// ── Main ──────────────────────────────────────────────────────────────────────
const monthArg = process.argv[2] ?? new Date().toISOString().slice(0, 7); // e.g. 2026-06
const [year, month] = monthArg.split('-').map(Number);
const fromDate = new Date(year, month - 1, 1);
const toDate = new Date(year, month, 1); // exclusive

console.log(`\n=== sync-product-rows: ${monthArg} ===`);
console.log(`Batch size: ${BATCH_SIZE} deals | Pause: ${PAUSE_MS / 1000}s between batches`);
console.log(`Estimated time: ~${Math.ceil((/* will fill */ 1) * PAUSE_MS / 1000 / 60)} min\n`);

const pool = createPool();

// Fetch all deal_ids for the month that don't have product_rows yet
const { rows: deals } = await pool.query(
  `SELECT deal_id FROM deals
   WHERE created_at >= $1 AND created_at < $2
      OR sold_at    >= $1 AND sold_at    < $2
   ORDER BY deal_id`,
  [fromDate.toISOString(), toDate.toISOString()]
);

const dealIds = [...new Set(deals.map(r => r.deal_id))];
console.log(`Deals to process: ${dealIds.length}`);
const totalBatches = Math.ceil(dealIds.length / BATCH_SIZE);
console.log(`Total batches: ${totalBatches} | ETA: ~${Math.round(totalBatches * PAUSE_MS / 1000 / 60)} min\n`);

let done = 0;
let classified = 0;
let unclassified = 0;
const unknown = []; // { dealId, products }

for (let i = 0; i < dealIds.length; i += BATCH_SIZE) {
  const chunk = dealIds.slice(i, i + BATCH_SIZE);
  const batchNum = Math.floor(i / BATCH_SIZE) + 1;

  // Build batch command: one productrows.get per deal
  const commands = {};
  for (const id of chunk) {
    commands[`d${id}`] = `crm.deal.productrows.get?id=${id}`;
  }

  let result;
  try {
    result = await bitrixBatch(commands);
  } catch (err) {
    console.error(`  Batch ${batchNum} error: ${err.message} — skipping`);
    await sleep(PAUSE_MS);
    continue;
  }

  // Build DB updates
  const updates = [];
  for (const id of chunk) {
    const rows = result[`d${id}`] ?? [];
    const group = pickGroupByMax(rows);

    if (rows.length > 0 && !group) {
      const names = rows.map(r => r.PRODUCT_NAME || r.NAME || '?').join('; ');
      unknown.push({ dealId: id, products: names });
      unclassified++;
    } else if (group) {
      classified++;
    }

    updates.push({ dealId: id, rows, group });
  }

  // Write to DB in one transaction
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const { dealId, rows, group } of updates) {
      await client.query(
        `UPDATE deals SET product_rows = $1, product_group_by_max = $2 WHERE deal_id = $3`,
        [JSON.stringify(rows), group, dealId]
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(`  DB write error batch ${batchNum}: ${err.message}`);
  } finally {
    client.release();
  }

  done += chunk.length;
  const pct = Math.round(done / dealIds.length * 100);
  console.log(`  [${batchNum}/${totalBatches}] ${done}/${dealIds.length} (${pct}%) | ok: ${classified} | ?unclassified: ${unclassified}`);

  if (i + BATCH_SIZE < dealIds.length) {
    await sleep(PAUSE_MS);
  }
}

await pool.end();

console.log(`\n=== Done ===`);
console.log(`Classified: ${classified}`);
console.log(`Cannot classify (need your help): ${unclassified}`);

if (unknown.length > 0) {
  console.log(`\n--- Deals where category could not be determined ---`);
  for (const { dealId, products } of unknown.slice(0, 50)) {
    console.log(`  Deal #${dealId}: ${products}`);
  }
  if (unknown.length > 50) console.log(`  ... and ${unknown.length - 50} more`);
  const outPath = `/home/junior/analsteroid/unclassified-${monthArg}.json`;
  fs.writeFileSync(outPath, JSON.stringify(unknown, null, 2));
  console.log(`\nFull list saved to: ${outPath}`);
}
