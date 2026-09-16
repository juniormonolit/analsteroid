// SFTP к логам сервера Битрикса через системный `sftp` (OpenSSH): без npm-зависимости —
// у Turbopack проблемы с трассировкой нативных пакетов в standalone (см. deploy.sh про pg).
// Доступ выдан админами 16.09.2026: td.monolit-crm.ru:2222, пользователь diagreader, только
// SFTP, ключ ed25519. Ключ лежит ВНЕ репозитория: .secrets/b24_diag_reader (gitignore) или путь
// из env B24_DIAG_SFTP_KEY. known_hosts — свой файл рядом, первое подключение accept-new.
import { execFile } from 'child_process';
import { mkdtemp, readFile, rm, access } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';

export interface RemoteFile { name: string; size: number }

const HOST = process.env.B24_DIAG_SFTP_HOST ?? 'td.monolit-crm.ru';
const PORT = process.env.B24_DIAG_SFTP_PORT ?? '2222';
const USER = process.env.B24_DIAG_SFTP_USER ?? 'diagreader';
const REMOTE_DIR = process.env.B24_DIAG_SFTP_PATH ?? '/logs';
const SECRETS_DIR = path.join(process.cwd(), '.secrets');
const KEY_PATH = process.env.B24_DIAG_SFTP_KEY ?? path.join(SECRETS_DIR, 'b24_diag_reader');

export function keyPath(): string { return KEY_PATH; }
export async function keyExists(): Promise<boolean> { try { await access(KEY_PATH); return true; } catch { return false; } }

function run(batch: string, timeoutMs = 120_000): Promise<string> {
  const args = [
    '-q', '-b', '-', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new',
    '-o', `UserKnownHostsFile=${path.join(path.dirname(KEY_PATH), 'known_hosts')}`,
    '-o', 'ConnectTimeout=20', '-P', PORT, '-i', KEY_PATH, `${USER}@${HOST}`,
  ];
  return new Promise((resolve, reject) => {
    const child = execFile('sftp', args, { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`sftp: ${(stderr || err.message).toString().trim().split('\n').slice(-2).join(' ')}`));
      else resolve(stdout.toString());
    });
    child.stdin?.end(batch);
  });
}

/** Список файлов diag_*.txt в /logs с размерами. */
export async function listRemote(): Promise<RemoteFile[]> {
  const out = await run(`ls -l ${REMOTE_DIR}\n`);
  const files: RemoteFile[] = [];
  for (const line of out.split('\n')) {
    // "-rw-r--r--    1 root     root        65953 Aug 17 12:03 diag_2026-08-17_15-03-01.txt"
    const m = line.match(/^-\S+\s+\d+\s+\S+\s+\S+\s+(\d+)\s+\S+\s+\d+\s+[\d:]+\s+(diag_\S+\.txt)$/);
    if (m) files.push({ name: m[2], size: Number(m[1]) });
  }
  return files.sort((a, b) => a.name.localeCompare(b.name));
}

/** Скачать набор файлов одной SFTP-сессией; возвращает имя → текст. */
export async function downloadRemote(names: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!names.length) return out;
  const dir = await mkdtemp(path.join(tmpdir(), 'b24diag-'));
  try {
    const batch = names.map(n => `get ${REMOTE_DIR}/${n} ${path.join(dir, n)}`).join('\n') + '\n';
    await run(batch, 300_000);
    for (const n of names) {
      try { out.set(n, await readFile(path.join(dir, n), 'utf8')); } catch { /* файл не скачался — пропустим, догоним в следующий раз */ }
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
  return out;
}
