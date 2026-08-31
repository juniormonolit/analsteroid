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
  /** Средняя температура недели (среднее суточных средних), °C. */
  tMean: number;
  /** Средняя облачность недели, %. */
  cloudPct: number;
  precipitationMm: number;
  rainMm: number;
  snowfallCm: number;
  /** Полная строка: «t 12…22, осадки 71 мм» — для развёрнутого вида. */
  summary: string;
  /** КОРОТКАЯ строка: «температура, одно слово» — «+5, пасмурно» / «−8, снег»
   *  (правка владельца 28.08: «в свёрнутом виде погода писалась коротко:
   *  „температура, 1 слово“»). */
  short: string;
}

/** Слово по средней облачности недели. Границы — стандартная шкала: до 20% —
 *  ясно, до 60% — переменная облачность, дальше пасмурно. */
function cloudWord(pct: number): string {
  if (pct < 20) return 'ясно';
  if (pct < 45) return 'малооблачно';
  if (pct < 70) return 'переменно';
  return 'пасмурно';
}

/** Слово по осадкам недели: снег/дожди/мокрый снег, с оговоркой «местами»,
 *  если осадков было мало. Порог 3 мм за НЕДЕЛЮ — ниже этого «без осадков»:
 *  0.4 мм за семь дней — это не «дожди». Используется в ПОЛНОЙ сводке. */
function precipWord(rainMm: number, snowCm: number): string {
  const snowy = snowCm >= 0.5;
  const rainy = rainMm >= 3;
  if (snowy && rainy) return 'снег с дождём';
  if (snowy) return snowCm >= 5 ? 'снег' : 'немного снега';
  if (rainy) return rainMm >= 20 ? 'дожди' : 'местами дожди';
  return 'без осадков';
}

/** ОДНО слово для короткой сводки: заметные осадки важнее облачности («снег» /
 *  «дожди»), иначе — облачность. Пороги заметности: снег от 2 см или дождь от
 *  10 мм за неделю; ниже этого погоду определяет небо, а не осадки. */
function headlineWord(cloudPct: number, rainMm: number, snowCm: number): string {
  if (snowCm >= 2) return 'снег';
  if (rainMm >= 10) return 'дожди';
  return cloudWord(cloudPct);
}

/** «+5» / «−8» / «0» — средняя температура со знаком, как в примере владельца. */
function tempWord(tMean: number): string {
  const r = Math.round(tMean);
  return r > 0 ? `+${r}` : r < 0 ? `−${Math.abs(r)}` : '0';
}

/** Погода за неделю [monday..sunday] (даты YYYY-MM-DD, обе включительно). */
export async function fetchWeekWeather(city: WeatherCity, monday: string, sunday: string): Promise<WeekWeatherAuto | null> {
  const c = WEATHER_CITIES[city];
  const url = 'https://archive-api.open-meteo.com/v1/archive'
    + `?latitude=${c.lat}&longitude=${c.lon}`
    + `&start_date=${monday}&end_date=${sunday}`
    + '&daily=temperature_2m_min,temperature_2m_max,temperature_2m_mean,cloud_cover_mean,precipitation_sum,rain_sum,snowfall_sum'
    + '&timezone=Europe%2FMoscow';
  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  } catch {
    return null; // сеть/таймаут — сводки просто не будет, отчёт не падает
  }
  if (!res.ok) return null;
  const data = await res.json() as {
    daily?: {
      temperature_2m_min?: (number | null)[]; temperature_2m_max?: (number | null)[];
      temperature_2m_mean?: (number | null)[]; cloud_cover_mean?: (number | null)[];
      precipitation_sum?: (number | null)[]; rain_sum?: (number | null)[]; snowfall_sum?: (number | null)[];
    };
  };
  const d = data.daily;
  const nums = (a?: (number | null)[]) => (a ?? []).filter((v): v is number => v !== null);
  const mins = nums(d?.temperature_2m_min);
  const maxs = nums(d?.temperature_2m_max);
  if (mins.length === 0 || maxs.length === 0) return null; // архив ещё не готов (лаг ~2-5 дней)
  const means = nums(d?.temperature_2m_mean);
  const clouds = nums(d?.cloud_cover_mean);
  const avg = (a: number[], fallback: number) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : fallback);
  const tMin = Math.round(Math.min(...mins));
  const tMax = Math.round(Math.max(...maxs));
  const tMean = Math.round(avg(means, (tMin + tMax) / 2) * 10) / 10;
  const cloudPct = Math.round(avg(clouds, 50));
  const sum = (a?: (number | null)[]) => (a ?? []).reduce<number>((s, v) => s + (v ?? 0), 0);
  const precipitationMm = Math.round(sum(d?.precipitation_sum));
  const rainMm = Math.round(sum(d?.rain_sum));
  const snowfallCm = Math.round(sum(d?.snowfall_sum) * 10) / 10;

  const parts = [`t ${tMin}…${tMax}`];
  parts.push(precipitationMm > 0 ? `осадки ${precipitationMm} мм` : 'без осадков');
  if (snowfallCm > 0) parts.push(`снег ${snowfallCm} см`);
  const short = `${tempWord(tMean)}, ${headlineWord(cloudPct, rainMm, snowfallCm)}`;
  return { tMin, tMax, tMean, cloudPct, precipitationMm, rainMm, snowfallCm, summary: parts.join(', '), short };
}
