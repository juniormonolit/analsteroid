// Задача 1706: имена скачиваемых файлов — латиница/транслит без пробелов
// («<название отчёта>-<период>»).
import { format } from 'date-fns';
import type { DateRange } from '@/lib/period';

const CYRILLIC_TO_LATIN: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i',
  й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't',
  у: 'u', ф: 'f', х: 'h', ц: 'c', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '',
  э: 'e', ю: 'yu', я: 'ya',
};

export function transliterate(s: string): string {
  return s
    .toLowerCase()
    .split('')
    .map(ch => CYRILLIC_TO_LATIN[ch] ?? ch)
    .join('');
}

export function slugify(s: string): string {
  return transliterate(s)
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-') || 'otchet';
}

export function buildExportFilename(title: string, period: DateRange): string {
  const from = format(period.from, 'yyyy-MM-dd');
  const to = format(period.to, 'yyyy-MM-dd');
  return `${slugify(title)}_${from}_${to}`;
}
