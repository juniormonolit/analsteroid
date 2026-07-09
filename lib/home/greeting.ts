import { toZonedTime } from 'date-fns-tz';

const TZ = 'Europe/Moscow';

// Границы времени суток (МСК) для приветствия на Главной (макет
// analsteroid-home-mock.html, брифа владельца): утро 5–12, день 12–18,
// вечер 18–5. Отдельного «ночь»-варианта в макете нет — поздняя ночь
// (0–5) тоже попадает в «вечер».
export function greetingWord(hour: number): 'Доброе утро' | 'Добрый день' | 'Добрый вечер' {
  if (hour >= 5 && hour < 12) return 'Доброе утро';
  if (hour >= 12 && hour < 18) return 'Добрый день';
  return 'Добрый вечер';
}

export function greetingForNow(): string {
  const hour = toZonedTime(new Date(), TZ).getHours();
  return greetingWord(hour);
}

// Имя из отображаемого имени пользователя (session.displayName, формат
// «Имя Фамилия») — берём первое слово, как в макете («Сергей» из «СБ»).
export function firstNameOf(displayName: string): string {
  const first = displayName.trim().split(/\s+/)[0];
  return first || displayName;
}
