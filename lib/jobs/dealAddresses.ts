// Фоновое поддержание кэша адресов объектов (задача владельца 21.09).
//
// Режим вежливости — правка владельца дословно: «Как минимум, делай батчами и
// в супервежливом режиме до 20:00, с 20:00 до 07:00 можно по полной хуярить».
// Отсюда две разные работы:
//   • ДНЁМ (07:00–20:00 МСК) — только НОВЫЕ сделки: обход от максимального
//     известного deal_id вперёд, мелкими порциями (10 команд по 50 = 500
//     сделок на запрос, пауза 3 с, максимум 4 запроса за тик). Новых сделок в
//     день — сотни, этого хватает с запасом, и портал не замечает нагрузки.
//   • НОЧЬЮ — полный проход по всей базе, чтобы подхватить ПРАВКИ адресов в
//     старых сделках (адрес уточняют руками). Один раз за ночь: запускается,
//     только если самая старая запись кэша старше 20 часов.
//
// Точечные запросы при открытии карточки (fetchDealAddresses) сюда не
// относятся — это работа менеджера, ≤50 id, идёт всегда.

import { backfillDealAddresses, dealAddressStats, isPoliteHours } from '@/lib/bitrix/dealAddress';

const FULL_SWEEP_AFTER_MS = 20 * 60 * 60 * 1000;
/** Потолок раундов ночного прохода: 20 batch-запросов на раунд × 2500 сделок. */
const MAX_NIGHT_ROUNDS = 12;

let running = false;

export async function dealAddressTick(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const stats = await dealAddressStats();
    const polite = isPoliteHours();
    const oldestAge = stats.oldestFetchedAt ? Date.now() - new Date(stats.oldestFetchedAt).getTime() : Infinity;

    if (!polite && oldestAge > FULL_SWEEP_AFTER_MS) {
      // Ночной полный проход: идём раундами, пока не кончатся сделки.
      let from = 0, scanned = 0, rounds = 0;
      const t0 = Date.now();
      do {
        const s = await backfillDealAddresses(from);
        scanned += s.scanned;
        from = s.lastId;
        rounds++;
      } while (from > 0 && rounds < MAX_NIGHT_ROUNDS);
      console.log(`[dealAddresses] ночной проход: ${scanned} сделок за ${Math.round((Date.now() - t0) / 1000)} с`);
      return;
    }

    // Обычный тик: только новые сделки (id больше максимального известного).
    const s = await backfillDealAddresses(stats.maxDealId);
    if (s.scanned > 0) {
      console.log(`[dealAddresses] новых сделок: ${s.scanned} (адрес у ${s.withAddress})${s.polite ? ', вежливый режим' : ''}`);
    }
  } catch (err) {
    console.error('[dealAddresses] тик упал:', err instanceof Error ? err.message : err);
  } finally {
    running = false;
  }
}
