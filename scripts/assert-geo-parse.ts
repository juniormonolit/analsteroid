// Проверки разбора поля «Адрес идеальный» без сети: ссылки на карты разных
// провайдеров, координаты в разных записях, варианты запроса для геокодера.
// Запуск: npm run test:geo-parse
import assert from 'node:assert/strict';
import { parseCoords, parseMapUrl, queryVariants, looksLikeUrl } from '../lib/geo/parse.ts';

const near = (a: { lat: number; lon: number } | null | undefined, lat: number, lon: number, msg: string) => {
  assert.ok(a, `${msg}: нет точки`);
  assert.ok(Math.abs(a!.lat - lat) < 1e-4 && Math.abs(a!.lon - lon) < 1e-4, `${msg}: ${JSON.stringify(a)} ≠ ${lat},${lon}`);
};

// ── Координаты ──
near(parseCoords('56.5262269, 37.5999556'), 56.5262269, 37.5999556, 'десятичные через запятую');
near(parseCoords('56,5262269 37,5999556'), 56.5262269, 37.5999556, 'запятая как разделитель дробной части');
near(parseCoords('56,5262269, 37,5999556'), 56.5262269, 37.5999556, 'запятые везде');
near(parseCoords('N56.52623 E37.59996'), 56.52623, 37.59996, 'буквы сторон света');
near(parseCoords('56°31\'34.4"N 37°35\'59.8"E'), 56.526222, 37.599944, 'градусы-минуты-секунды');
near(parseCoords('56°31′34″ С 37°35′59″ В'), 56.526111, 37.599722, 'ГМС кириллицей');
near(parseCoords('37.5999556, 56.5262269 E N'.replace(' E N', '')), 37.5999556, 56.5262269, 'порядок как есть, если оба ≤ 90');
assert.equal(parseCoords('ул. Рената Саипова, 40'), null, 'адрес с цифрами — не координаты');
assert.equal(parseCoords('353440, Анапский р-н'), null, 'индекс — не координаты');
assert.equal(parseCoords('Москва'), null);

// ── Ссылки ──
near(parseMapUrl('https://yandex.ru/maps/?ll=37.617635%2C55.755814&pt=37.599956,56.526227&z=17')?.point, 56.526227, 37.599956, 'Яндекс pt важнее ll');
near(parseMapUrl('https://yandex.ru/maps/213/moscow/?ll=37.617635%2C55.755814&z=10')?.point, 55.755814, 37.617635, 'Яндекс ll');
near(parseMapUrl('https://yandex.ru/maps/?whatshere%5Bpoint%5D=30.468043%2C60.136031&whatshere%5Bzoom%5D=17')?.point, 60.136031, 30.468043, 'Яндекс «что здесь»');
near(parseMapUrl('https://www.google.com/maps/place/Verbilki/@56.52,37.59,15z/data=!3m1!4b1!4m6!3m5!1s0x0:0x0!8m2!3d56.5262269!4d37.5999556')?.point, 56.5262269, 37.5999556, 'Google !3d!4d важнее @');
near(parseMapUrl('https://www.google.com/maps/@59.939084,30.315879,17z')?.point, 59.939084, 30.315879, 'Google @');
near(parseMapUrl('https://maps.google.com/?q=59.939084,30.315879')?.point, 59.939084, 30.315879, 'Google q=');
near(parseMapUrl('https://2gis.ru/spb/geo/5348552838550587?m=30.315879%2C59.939084%2F16')?.point, 59.939084, 30.315879, '2ГИС m=');
near(parseMapUrl('https://www.openstreetmap.org/?mlat=60.946184&mlon=30.34562#map=17/60.946184/30.34562')?.point, 60.946184, 30.34562, 'OSM mlat');
near(parseMapUrl('https://www.openstreetmap.org/#map=17/60.946184/30.34562')?.point, 60.946184, 30.34562, 'OSM #map');
near(parseMapUrl('https://maps.apple.com/?ll=55.7558,37.6173&q=Pin')?.point, 55.7558, 37.6173, 'Apple ll');
assert.equal(parseMapUrl('https://yandex.ru/maps/-/CDqZaV2s'), null, 'короткая ссылка без координат — раскрывает сервер');
assert.ok(looksLikeUrl('yandex.ru/maps/-/CDqZaV2s'));
assert.ok(!looksLikeUrl('Горышкино, Одинцовский округ'));

// ── Варианты запроса ──
const v1 = queryVariants('Горышкино, Одинцовский городской округ, Московская область, Центральный федеральный округ, 143032, Россия');
assert.ok(v1.includes('Московская область, Одинцовский городской округ, Горышкино'), `разворот: ${JSON.stringify(v1)}`);
assert.ok(v1.includes('Московская область, Горышкино'), `без муниципального слоя: ${JSON.stringify(v1)}`);
const v2 = queryVariants('32, Романовка, Романовское сельское поселение, Всеволожский район, Ленинградская область, Северо-Западный федеральный округ, 188');
assert.ok(v2.some(v => v.startsWith('Ленинградская область, Всеволожский район') && v.endsWith('Романовка, 32')), `дом в конце: ${JSON.stringify(v2)}`);
const v3 = queryVariants('353440, Краснодарский край, Анапский р-н, станица Анапская, ул. Рената Саипова, 40.');
assert.ok(v3.some(v => v.startsWith('Краснодарский край, Анапский р-н')), `без индекса: ${JSON.stringify(v3)}`);

console.log('geo-parse: все проверки прошли');
