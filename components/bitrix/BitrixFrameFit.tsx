'use client';

import { useEffect } from 'react';

// Подгоняет высоту iframe под контент внутри Битрикса. Без этого портал держит
// фрейм фиксированной высоты и карточка обрезается (у неё высота меняется по мере
// загрузки блоков и при смене периода — поэтому ResizeObserver, а не одиночный вызов).
//
// BX24.js отдаётся Битриксом и работает и в облаке, и в «коробке». Скрипт грузим
// сами: он есть только внутри фрейма портала, вне Битрикса компонент просто ничего
// не делает (страницу можно открыть напрямую для отладки).
interface BX24Api { init(cb: () => void): void; fitWindow(): void }
declare global {
  interface Window { BX24?: BX24Api }
}

const SDK_URL = 'https://api.bitrix24.com/api/v1/';

export function BitrixFrameFit() {
  useEffect(() => {
    // Вне iframe делать нечего
    if (window.self === window.top) return;

    let observer: ResizeObserver | null = null;
    let cancelled = false;

    const start = () => {
      const bx = window.BX24;
      if (cancelled || !bx) return;
      bx.init(() => {
        const fit = () => { try { bx.fitWindow(); } catch { /* портал закрыл фрейм */ } };
        fit();
        observer = new ResizeObserver(fit);
        observer.observe(document.body);
      });
    };

    if (window.BX24) {
      start();
    } else {
      const s = document.createElement('script');
      s.src = SDK_URL;
      s.async = true;
      s.onload = start;
      document.head.appendChild(s);
    }

    return () => { cancelled = true; observer?.disconnect(); };
  }, []);

  return null;
}
