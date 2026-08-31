// Автопогода для спец-отчёта «Данные по годам» (решение владельца 28.08:
// «подключись к какому-нибудь бесплатному сервису реальной погоды и проставляй
// данные и оттуда тоже»). Выбран Open-Meteo (archive-api.open-meteo.com):
// бесплатный, без ключа и регистрации, исторический архив по координатам,
// проверен живым запросом 28.08. Автосводка — ПРИПИСКА к живому комментарию
// ответственного, не замена: оценки вроде «дороги почищены» API не даст.

export type WeatherCity = 'spb' | 'msk' | 'krd';

export const WEATHER_CITIES: Record<WeatherCity, { label: string; lat: number; lon: number }> = {
  spb: { label: 'СПб', lat: 59.94, lon: 30.31 },
  msk: { label: 'Москва', lat: 55.75, lon: 37.62 },
  krd: { label: 'Краснодар', lat: 45.04, lon: 38.98 },
};

export interface WeekWeatherAuto {
  tMin: number;
  tMax: number;
  precipitationMm: number;
  snowfallCm: number;
  /** Готовая строка в стиле ручного файла: «t 12…22, осадки 71 мм». */
  summary: string;
}

/** Погода за неделю [monday..sunday] (даты YYYY-MM-DD, обе включительно). */
export async function fetchWeekWeather(city: WeatherCity, monday: string, sunday: string): Promise<WeekWeatherAuto | null> {
  const c = WEATHER_CITIES[city];
  const url = 'https://archive-api.open-meteo.com/v1/archive'
    + `?latitude=${c.lat}&longitude=${c.lon}`
    + `&start_date=${monday}&end_date=${sunday}`
    + '&daily=temperature_2m_min,temperature_2m_max,precipitation_sum,snowfall_sum'
    + '&timezone=Europe%2FMoscow';
  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  } catch {
    return null; // сеть/таймаут — сводки просто не будет, отчёт не падает
  }
  if (!res.ok) return null;
  const data = await res.json() as {
    daily?: { temperature_2m_min?: (number | null)[]; temperature_2m_max?: (number | null)[]; precipitation_sum?: (number | null)[]; snowfall_sum?: (number | null)[] };
  };
  const d = data.daily;
  const mins = (d?.temperature_2m_min ?? []).filter((v): v is number => v !== null);
  const maxs = (d?.temperature_2m_max ?? []).filter((v): v is number => v !== null);
  if (mins.length === 0 || maxs.length === 0) return null; // архив ещё не готов (лаг ~2-5 дней)
  const tMin = Math.round(Math.min(...mins));
  const tMax = Math.round(Math.max(...maxs));
  const precipitationMm = Math.round((d?.precipitation_sum ?? []).reduce<number>((s, v) => s + (v ?? 0), 0));
  const snowfallCm = Math.round((d?.snowfall_sum ?? []).reduce<number>((s, v) => s + (v ?? 0), 0) * 10) / 10;

  const parts = [`t ${tMin}…${tMax}`];
  parts.push(precipitationMm > 0 ? `осадки ${precipitationMm} мм` : 'без осадков');
  if (snowfallCm > 0) parts.push(`снег ${snowfallCm} см`);
  return { tMin, tMax, precipitationMm, snowfallCm, summary: parts.join(', ') };
}
