// Задача 1706: снимок PNG узла таблицы отчёта — html-to-image, динамический import()
// (не тянем в основной бандл). Библиотека выбрана вместо html2canvas: активнее
// поддерживается, лучше работает со свежими CSS-фичами (color-mix используется в
// подсветке метрик, ReportTable.tsx), меньше веса.
//
// Длинные отчёты (ограничение первой итерации, см. WORKLOG): таблица рендерится внутри
// прокручиваемого div (`overflow-auto h-full`, ReportTable.tsx) — снимается ВЕСЬ
// скроллируемый контент, а не только видимый вьюпорт: на время снимка контейнеру
// временно выставляется overflow:visible + явные width/height = scrollWidth/scrollHeight
// (см. captureTableNode), после снимка стили возвращаются. Sticky-заголовок/закреплённые
// колонки при этом не «плывут» и не дублируются — без активного скролл-контекста
// position:sticky у них ведёт себя как обычный поток (thead и так первая строка/колонка
// в DOM), что и требуется для статичного снимка.
export interface CapturedImage {
  dataUrl: string;
  width: number;
  height: number;
}

export async function captureTableNode(node: HTMLElement): Promise<CapturedImage> {
  const { toPng } = await import('html-to-image');

  const fullWidth = Math.ceil(node.scrollWidth);
  const fullHeight = Math.ceil(node.scrollHeight);

  const prev = {
    overflow: node.style.overflow,
    height: node.style.height,
    width: node.style.width,
    maxHeight: node.style.maxHeight,
  };
  node.style.overflow = 'visible';
  node.style.height = `${fullHeight}px`;
  node.style.width = `${fullWidth}px`;
  node.style.maxHeight = 'none';

  try {
    const bg = getComputedStyle(document.documentElement).getPropertyValue('--color-bg-surface').trim() || '#ffffff';
    const dataUrl = await toPng(node, {
      width: fullWidth,
      height: fullHeight,
      pixelRatio: 2,
      backgroundColor: bg || undefined,
      cacheBust: true,
    });
    return { dataUrl, width: fullWidth, height: fullHeight };
  } finally {
    node.style.overflow = prev.overflow;
    node.style.height = prev.height;
    node.style.width = prev.width;
    node.style.maxHeight = prev.maxHeight;
  }
}

function dataUrlToBlob(dataUrl: string): Blob {
  const [meta, b64] = dataUrl.split(',');
  const mimeMatch = /data:(.*?);base64/.exec(meta);
  const mime = mimeMatch ? mimeMatch[1] : 'image/png';
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

export async function exportNodeToPng(node: HTMLElement, filenameBase: string): Promise<void> {
  const { downloadBlob } = await import('./downloadBlob');
  const { dataUrl } = await captureTableNode(node);
  downloadBlob(dataUrlToBlob(dataUrl), `${filenameBase}.png`);
}
