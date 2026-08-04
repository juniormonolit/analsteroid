// Своя картинка для карточки товара (задача 2994, правка владельца: «можно
// вставить картинку из интернета?»). Два пути на вход — файл (base64 из
// браузера) и ссылка (сервер качает сам, СХД у нас нет — см. миграцию 101
// idea_attachments, тот же приём: байты в bytea, отдаём своим роутом, чтобы
// карточка НЕ зависела от чужого сайта и не била туда при каждом показе).
//
// СЕРВЕРНЫЙ модуль (использует node:dns/net) — импортировать только из
// app/api/**, никогда из 'use client' компонентов.

import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

export const SHOP_IMAGE_MAX_BYTES = 3 * 1024 * 1024; // 3 МБ — маленькая квадратная иконка, не скриншот
// SVG сознательно НЕ в списке: это XML, может нести <script>/onload/внешние
// ссылки — без санитайзера (в проекте такого нет, тащить библиотеку ради
// одного поля не стали, см. коммент задачи) принимать его небезопасно.
export const SHOP_IMAGE_ALLOWED_MIME = ['image/png', 'image/jpeg', 'image/webp'] as const;
export type ShopImageMime = (typeof SHOP_IMAGE_ALLOWED_MIME)[number];

/** Сигнатура файла по магическим байтам — источник правды о типе, а не
 * Content-Type заголовок или расширение (оба подделываемы клиентом/сервером). */
export function sniffImageMime(buf: Buffer): ShopImageMime | null {
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47
    && buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a) {
    return 'image/png';
  }
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return 'image/jpeg';
  }
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    return 'image/webp';
  }
  return null;
}

export interface DecodedImage { mime: ShopImageMime; buffer: Buffer }

/** Файл с клиента: base64 → байты, размер + сигнатура проверяются на СЕРВЕРЕ
 * (клиентские проверки — только для UX, не доверяем). */
export function decodeUploadedImage(dataBase64: string): DecodedImage | string {
  let buf: Buffer;
  try {
    buf = Buffer.from(dataBase64, 'base64');
  } catch {
    return 'Некорректные данные картинки (base64)';
  }
  if (buf.length === 0) return 'Пустой файл';
  if (buf.length > SHOP_IMAGE_MAX_BYTES) {
    return `Файл больше ${Math.floor(SHOP_IMAGE_MAX_BYTES / 1024 / 1024)} МБ`;
  }
  const mime = sniffImageMime(buf);
  if (!mime) return 'Формат не распознан — разрешены только PNG, JPEG, WEBP (SVG не поддерживается)';
  return { mime, buffer: buf };
}

// ── SSRF-защита для скачивания по ссылке ────────────────────────────────────
// Сервер сам идёт по URL, который ввёл пользователь, — классический SSRF
// (может дотянуться до localhost/приватных сетей/облачных метадата-эндпоинтов).
// Меры: только http(s), резолвим хост и проверяем IP ДО подключения на каждом
// хопе редиректа (redirect:'manual', сами валидируем Location), таймаут,
// потоковый лимит байт (не доверяем Content-Length), сигнатура по факту
// содержимого — а не Content-Type/расширению.

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const FETCH_TIMEOUT_MS = 8_000;
const MAX_REDIRECTS = 4;

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    const v = Number(p);
    if (!Number.isInteger(v) || v < 0 || v > 255) return null;
    n = (n << 8) | v;
  }
  return n >>> 0;
}

function inCidrV4(ip: string, base: string, bits: number): boolean {
  const ipInt = ipv4ToInt(ip);
  const baseInt = ipv4ToInt(base);
  if (ipInt === null || baseInt === null) return false;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (ipInt & mask) === (baseInt & mask);
}

// Приватные/служебные/reserved диапазоны IPv4 — включая cloud-metadata
// 169.254.169.254 (попадает в 169.254.0.0/16) и Tailscale CGNAT 100.64.0.0/10
// (наша же внутренняя сеть — MLT-инфра сидит на 100.x, см. devops.md).
const V4_BLOCKED: [string, number][] = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
  ['224.0.0.0', 4], ['240.0.0.0', 4],
];

function isPrivateOrReservedIp(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) return V4_BLOCKED.some(([base, bits]) => inCidrV4(ip, base, bits));
  if (v === 6) {
    const low = ip.toLowerCase();
    if (low === '::1' || low === '::') return true;
    if (low.startsWith('fe80:') || low.startsWith('fe8') || low.startsWith('fe9') || low.startsWith('fea') || low.startsWith('feb')) return true; // link-local fe80::/10
    if (/^f[cd][0-9a-f]{2}:/.test(low)) return true; // unique local fc00::/7
    // IPv4-mapped (::ffff:a.b.c.d) — проверить вложенный IPv4.
    const mapped = low.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateOrReservedIp(mapped[1]);
    return false;
  }
  return true; // не распознали формат — блокируем по умолчанию (default-deny)
}

export async function safeFetchImageFromUrl(inputUrl: string): Promise<DecodedImage | string> {
  let current: URL;
  try {
    current = new URL(inputUrl);
  } catch {
    return 'Некорректная ссылка';
  }

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (current.protocol !== 'http:' && current.protocol !== 'https:') {
      return 'Разрешены только http(s)-ссылки';
    }
    const hostname = current.hostname;
    let ip: string;
    try {
      if (isIP(hostname)) {
        ip = hostname;
      } else {
        const r = await lookup(hostname);
        ip = r.address;
      }
    } catch {
      return 'Не удалось определить адрес хоста';
    }
    if (isPrivateOrReservedIp(ip)) {
      return 'Ссылка ведёт на внутренний/служебный адрес — запрещено';
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(current, {
        redirect: 'manual', // сами валидируем Location — не следуем редиректам вслепую
        signal: controller.signal,
        headers: { 'User-Agent': 'MonolitikaShopImageFetcher/1.0' },
      });
    } catch (e) {
      return e instanceof Error && e.name === 'AbortError'
        ? 'Истекло время ожидания ответа'
        : 'Не удалось скачать по ссылке';
    } finally {
      clearTimeout(timer);
    }

    if (REDIRECT_STATUSES.has(res.status)) {
      const loc = res.headers.get('location');
      if (!loc) return 'Редирект без адреса назначения';
      try {
        current = new URL(loc, current);
      } catch {
        return 'Некорректный адрес редиректа';
      }
      continue; // следующая итерация заново резолвит и проверяет IP нового хоста
    }
    if (!res.ok) return `Сервер вернул ошибку ${res.status}`;

    const cl = res.headers.get('content-length');
    if (cl && Number(cl) > SHOP_IMAGE_MAX_BYTES) {
      return `Файл больше ${Math.floor(SHOP_IMAGE_MAX_BYTES / 1024 / 1024)} МБ`;
    }
    if (!res.body) return 'Пустой ответ';

    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > SHOP_IMAGE_MAX_BYTES) {
        await reader.cancel().catch(() => {});
        return `Файл больше ${Math.floor(SHOP_IMAGE_MAX_BYTES / 1024 / 1024)} МБ`;
      }
      chunks.push(value);
    }
    const buf = Buffer.concat(chunks.map((c) => Buffer.from(c)));
    const mime = sniffImageMime(buf);
    if (!mime) return 'Содержимое не похоже на PNG/JPEG/WEBP (по факту байтов, не по заголовку)';
    return { mime, buffer: buf };
  }
  return 'Слишком много редиректов';
}
