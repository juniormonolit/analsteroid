'use client';

// Общий хелпер клиентских запросов к денежным ручкам (задача #2995). Паттерн:
// первый запрос без пина; если бэк ответил {pinRequired:true} (статус
// 428/403/423) — вызывающий открывает PinSetupDialog (428, пин ещё не
// установлен) или PinDialog (403/423, пин уже есть — неверный/лок) и
// повторяет тот же запрос с полем `pin` в теле.

export interface PinFetchResult<T = unknown> {
  ok: boolean;
  status: number;
  needsPinSetup: boolean;  // 428 — пин не установлен вовсе
  needsPinVerify: boolean; // pinRequired, но 428 не подходит — пин есть, нужен ввод/повтор
  data: T | null;
  error: string | null;
}

export async function fetchPinGated<T = unknown>(
  url: string, method: 'POST' | 'PATCH', body: Record<string, unknown>,
): Promise<PinFetchResult<T>> {
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as { error?: string; pinRequired?: boolean } & Record<string, unknown>;
  if (res.ok) {
    return { ok: true, status: res.status, needsPinSetup: false, needsPinVerify: false, data: json as T, error: null };
  }
  const pinRequired = json.pinRequired === true;
  return {
    ok: false,
    status: res.status,
    needsPinSetup: pinRequired && res.status === 428,
    needsPinVerify: pinRequired && res.status !== 428,
    data: null,
    error: json.error ?? `HTTP ${res.status}`,
  };
}
