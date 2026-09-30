import { isCreatedTimeFilter, isFirstTouchFilter } from '../metrics/offHoursFilters';

// Проверка «сырых» полей тела запроса отчётов, которые движки вставляют в SQL
// (аудит безопасности 29.09, задача #8256, находки D1/D2):
//  - createdTimeFilter / firstTouchFilter — только значения из закрытого списка;
//  - managerId — только число (движки byProductGroups/byDealBuckets клеят его
//    в `d.current_manager_id = ${managerId}`).
// Возвращает текст ошибки для ответа 400 или null. Отсутствие поля = не задано.
export function reportFiltersError(body: Record<string, unknown> | null | undefined): string | null {
  const b = body ?? {};
  if (b.createdTimeFilter !== undefined && b.createdTimeFilter !== null && !isCreatedTimeFilter(b.createdTimeFilter)) {
    return 'createdTimeFilter: недопустимое значение';
  }
  if (b.firstTouchFilter !== undefined && b.firstTouchFilter !== null && !isFirstTouchFilter(b.firstTouchFilter)) {
    return 'firstTouchFilter: недопустимое значение';
  }
  const m = b.managerId;
  if (m !== undefined && m !== null && m !== '' && !isNumericId(m)) {
    return 'managerId: ожидается числовой ID менеджера';
  }
  return null;
}

export function isNumericId(v: unknown): boolean {
  if (typeof v === 'number') return Number.isSafeInteger(v) && v >= 0;
  return typeof v === 'string' && /^\d{1,18}$/.test(v);
}
