// Кладёт воркер MapLibre в public/, чтобы карта работала в сборке Next.
//
// ЗАЧЕМ (живой инцидент 21.09: карта рисовала тайлы, но ни одной точки).
// MapLibre вычисляет адрес своего воркера как `new URL('./maplibre-gl-worker.mjs',
// import.meta.url)`. Внутри бандла Next `import.meta.url` указывает на чанк
// (/_next/static/chunks/...), где такого файла нет — воркер молча не стартует.
// Растровым тайлам воркер не нужен, поэтому подложка рисуется как ни в чём не
// бывало, а ВСЕ источники GeoJSON остаются неразобранными: слои есть, фичи в
// источнике есть, на экране ноль, а map.isStyleLoaded() навсегда false.
//
// Лечится указанием config.WORKER_URL на файл, который отдаём мы сами
// (features/map/ui/mapEngine.ts::ensureWorkerUrl). Воркер — ES-модуль и тянет
// соседний maplibre-gl-shared.mjs, поэтому копируем ОБА файла в одну папку,
// сохраняя имена: относительный импорт внутри воркера должен разрешиться.
//
// Файлы генерируемые, в git не хранятся (.gitignore) — deploy.sh пакует public/
// с локальной файловой системы уже после сборки.
import { mkdirSync, copyFileSync, existsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'node_modules', 'maplibre-gl', 'dist');
const dest = join(root, 'public', 'maplibre');
const FILES = ['maplibre-gl-worker.mjs', 'maplibre-gl-shared.mjs'];

if (!existsSync(src)) {
  console.error('[maplibre] node_modules/maplibre-gl/dist не найден — карта работать не будет');
  process.exit(1);
}
mkdirSync(dest, { recursive: true });
for (const f of FILES) {
  const from = join(src, f);
  if (!existsSync(from)) {
    console.error(`[maplibre] в пакете нет ${f} — проверьте версию maplibre-gl`);
    process.exit(1);
  }
  copyFileSync(from, join(dest, f));
  console.log(`[maplibre] ${f} → public/maplibre/ (${Math.round(statSync(from).size / 1024)} КБ)`);
}
