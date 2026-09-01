'use client';
import { useEffect, useRef } from 'react';

// Закрытие самописных оверлеев по Esc (правка владельца 31.08: «чтобы всякая
// хуйня реагировала на нажатие Esc»). Radix-модалки и поповеры закрываются сами,
// а панели вида fixed inset-0 / слайд-дровер (дриллдаун, карточка сделки,
// графики, сравнение, чат) — не реагировали никак.
//
// Почему стек, а не просто addEventListener в каждом компоненте: панели
// вкладываются (карточка сделки поверх дриллдауна поверх отчёта), и Esc должен
// закрывать ТОЛЬКО верхнюю, а не все разом. Каждый смонтированный хук
// регистрируется в модульном стеке; обработчик один на документ и зовёт только
// вершину.
//
// Слушаем keydown в capture-фазе, но уступаем всем, кто обработал Esc сам
// (defaultPrevented — например, инпут названия группы гасит Esc как «отмена
// ввода»). Radix свои оверлеи закрывает сам и останавливает событие, поэтому
// поверх открытого Radix-попапа наш стек не срабатывает — ровно то, что нужно.

type Entry = { close: () => void };
const stack: Entry[] = [];
let listenerOn = false;

function onKeyDown(e: KeyboardEvent) {
  if (e.key !== 'Escape' || e.defaultPrevented) return;
  const top = stack[stack.length - 1];
  if (!top) return;
  e.preventDefault();
  top.close();
}

function ensureListener() {
  if (listenerOn) return;
  document.addEventListener('keydown', onKeyDown);
  listenerOn = true;
}

/**
 * Пока компонент смонтирован (и enabled !== false), Esc закрывает его через
 * onClose — если он верхний в стеке открытых оверлеев.
 */
export function useEscapeClose(onClose: () => void, enabled = true) {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    if (!enabled) return;
    ensureListener();
    const entry: Entry = { close: () => closeRef.current() };
    stack.push(entry);
    return () => {
      const i = stack.indexOf(entry);
      if (i >= 0) stack.splice(i, 1);
    };
  }, [enabled]);
}
