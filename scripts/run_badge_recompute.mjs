// Ручной запуск пересчёта наград тем же движком, что ночная джоба
// (features/badges/engine/compute.ts → runBadgeRecompute). Нужен после разовой
// чистки мусорных начислений, чтобы заслуженные вернулись сразу, а не ночью.
// Запуск: npx tsx scripts/run_badge_recompute.mjs
// .env.local читаем сами: dotenv в зависимостях нет, а @next/env тут избыточен.
// Важно: файл хранит $ экранированным (\$) — разэкранируем (см. память проекта).
import { readFileSync } from 'fs';
for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
  const m = line.match(/^([A-Z_0-9]+)=(.*)$/);
  if (m) process.env[m[1]] = m[2].replace(/\\\$/g, '$').replace(/^"|"$/g, '');
}
const { runBadgeRecompute } = await import('../features/badges/engine/compute.ts');
const t0 = Date.now();
const stats = await runBadgeRecompute();
console.log(`готово за ${Math.round((Date.now() - t0) / 1000)} с:`, JSON.stringify(stats, null, 1).slice(0, 900));
process.exit(0);
