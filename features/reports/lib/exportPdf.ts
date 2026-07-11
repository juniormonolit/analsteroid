// Задача 1706: «Скачать PDF» — тот же снимок узла таблицы (captureTableNode), встроенный
// в PDF (jsPDF), альбомная ориентация, масштаб по ширине страницы. Первая итерация —
// ОДНОСТРАНИЧНЫЙ PDF с масштабированием под высоту страницы (многостраничная разбивка
// длинных отчётов — дороже реализовать надёжно с sticky-шапкой на каждой странице,
// отмечено как ограничение в отчёте задачи 1706). Динамический import() — jsPDF не
// тянется в основной бандл.
import { captureTableNode } from './exportImage';

const PT_PER_PX = 0.75; // 96dpi px → pt (72/96)

export async function exportNodeToPdf(node: HTMLElement, filenameBase: string): Promise<void> {
  const { dataUrl, width, height } = await captureTableNode(node);
  const { jsPDF } = await import('jspdf');

  const doc = new jsPDF({ orientation: 'landscape', unit: 'pt', format: 'a4' });
  const margin = 24;
  const pageWidth = doc.internal.pageSize.getWidth() - margin * 2;
  const pageHeight = doc.internal.pageSize.getHeight() - margin * 2;

  const imgWidthPt = width * PT_PER_PX;
  const imgHeightPt = height * PT_PER_PX;
  const ratio = imgHeightPt / imgWidthPt;

  let renderWidth = pageWidth;
  let renderHeight = renderWidth * ratio;
  if (renderHeight > pageHeight) {
    renderHeight = pageHeight;
    renderWidth = renderHeight / ratio;
  }

  // 'FAST' — zlib-сжатие встроенного изображения: без него jsPDF кладёт битмап
  // почти без сжатия, и PDF длинного отчёта раздувается до десятков МБ.
  doc.addImage(dataUrl, 'PNG', margin, margin, renderWidth, renderHeight, undefined, 'FAST');
  doc.save(`${filenameBase}.pdf`);
}
