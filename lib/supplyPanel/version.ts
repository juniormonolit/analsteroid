/**
 * Сторож методики: порт lib/supplyPanel сделан с конкретной версии Панели снабжения. Панель
 * правят (21.10 сняли «тестовые» задачи и поменяли конверсию — цифры неделю расходились молча),
 * поэтому раз в сутки берём архив кода панели (команда `code`) и сверяем отпечаток ФАЙЛОВ РАСЧЁТА
 * (calc/metrics/domcalc/catalog + справочники) с PORTED_CALC_SHA256. Коммит панели сам по себе не
 * показатель: его двигают и правки мотивации/админки, которые мы не переносим (22.10 — так и было).
 * Расхождение — предупреждение в лог и плашка в разделе; сам расчёт не меняется до переноса правок
 * (сверка — npm run verify:supply-panel).
 */
import { spawn } from 'node:child_process';
import { gunzipSync } from 'node:zlib';
import { sshArgs } from './source';

import { createHash } from 'node:crypto';

/** Версия панели, с которой сделан и сверен порт (обновлять вместе с переносом правок). */
export const PORTED_COMMIT = 'b744b1e9594f26755bbc993d48b723e6d66c5e77';
/** sha256 склейки CALC_FILES этой версии: `cd refresh && cat <CALC_FILES> | shasum -a 256`. */
export const PORTED_CALC_SHA256 = '6b0ae1dc611be9158900ef62cb4858b8e3a19a10dd89de1390345e6f569d8709';
const CALC_FILES = ['calc.py', 'metrics.py', 'domcalc.py', 'catalog.py', 'accounts.json', 'regions.json', 'departments.json', 'suppliers.json'];

export interface PanelVersion { commit: string | null; calcSha256: string | null; checkedAt: string; matches: boolean }

const CHECK_EVERY_MS = 24 * 3600_000;
const g = globalThis as unknown as { __supplyPanelVersion?: PanelVersion & { at: number } };

function sshBinary(cmd: string, timeoutMs = 60_000, maxBytes = 20 * 1024 * 1024): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const p = spawn('ssh', [...sshArgs(), cmd], { stdio: ['ignore', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    let size = 0;
    const timer = setTimeout(() => { p.kill('SIGKILL'); reject(new Error(`ssh ${cmd}: таймаут`)); }, timeoutMs);
    p.stdout.on('data', (b: Buffer) => {
      size += b.length;
      if (size > maxBytes) { p.kill('SIGKILL'); clearTimeout(timer); reject(new Error(`ssh ${cmd}: слишком большой ответ`)); return; }
      out.push(b);
    });
    p.on('error', e => { clearTimeout(timer); reject(e); });
    p.on('close', code => { clearTimeout(timer); if (code) reject(new Error(`ssh ${cmd}: код ${code}`)); else resolve(Buffer.concat(out)); });
  });
}

/** Файл из tar (ustar): имя — 100 байт с 0, размер — восьмеричный с 124. */
export function tarFile(tar: Buffer, suffix: string): string | null {
  for (let off = 0; off + 512 <= tar.length;) {
    const name = tar.subarray(off, off + 100).toString('utf8').replace(/\0[\s\S]*$/, '');
    if (!name) return null;
    const size = parseInt(tar.subarray(off + 124, off + 136).toString('utf8').replace(/\0[\s\S]*$/, '').trim() || '0', 8);
    if (name.endsWith(suffix)) return tar.subarray(off + 512, off + 512 + size).toString('utf8');
    off += 512 + Math.ceil(size / 512) * 512;
  }
  return null;
}

/** Коммит панели и отпечаток файлов расчёта, с кэшем на сутки. Ошибка сети — прежнее значение или null. */
export async function checkPanelVersion(now = Date.now()): Promise<PanelVersion | null> {
  const c = g.__supplyPanelVersion;
  if (c && now - c.at < CHECK_EVERY_MS) return c;
  if ((process.env.SUPPLY_PANEL_SOURCE || 'ssh').trim() !== 'ssh') return null;
  try {
    const tar = gunzipSync(await sshBinary('code'));
    const commit = tarFile(tar, 'supply-panel/VERSION')?.match(/[0-9a-f]{40}/)?.[0] ?? null;
    const parts = CALC_FILES.map(f => tarFile(tar, `supply-panel/refresh/${f}`));
    const calcSha256 = parts.every(p => p !== null) ? createHash('sha256').update(parts.join('')).digest('hex') : null;
    const v = { commit, calcSha256, checkedAt: new Date(now).toISOString(), matches: calcSha256 === PORTED_CALC_SHA256, at: now };
    g.__supplyPanelVersion = v;
    if (!v.matches) console.warn(`[supplyPanelSync] расчёт панели изменился: коммит панели ${commit ?? '?'}, порт сверен с ${PORTED_COMMIT} — перенести правки calc/metrics и сверить (npm run verify:supply-panel)`);
    return v;
  } catch (e) {
    console.warn('[supplyPanelSync] версию панели проверить не удалось:', e instanceof Error ? e.message : e);
    return c ?? null;
  }
}

/** Последний результат проверки (без сети) — для /meta и плашки. */
export const lastPanelVersion = (): PanelVersion | null => g.__supplyPanelVersion ?? null;
