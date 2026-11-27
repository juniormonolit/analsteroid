// Разбор объявлений чатов «Увольнения» и стажёров (чистые функции, без БД — проверяются юнит-скриптом).
// Примеры: «[USER=123]Владислав Пшеничный[/USER] М60 - уволен», «М121 Большакова Анастасия - уволен\nМ131 …»,
// «Таранюк Ирина М305-уволена», «Манафов Тамерлан уволен», «Logist2002 Анна Супрун - уволена».
// Одна строка с корнем «увол» = одно лицо. Логины: кириллическая «М» и латинская «M» — одно и то же.

export interface ParsedLine {
  line: string;
  /** [USER=id] в строке */
  mentionId: number | null;
  /** Логин как написан (М60, Logist2002) */
  login: string | null;
  /** Варианты LOGIN Битрикса в нижнем регистре: «М60» → manager60, m60 */
  loginKeys: string[];
  /** «Фамилия Имя» / «Имя Фамилия» как написано (только слова с заглавной, кириллица) */
  name: string | null;
}

// «увол…» — чат «Увольнения»; «не прошёл/прошла стажировку» — чат стажёров «Увольнение стажеров (Обучение/Адаптация)»
// (владелец 27.11). Экспорт — опрос чата отбирает сообщения тем же правилом.
export const DISMISS_RE = /увол|не\s+прош(?:[её]л|ла|ли)\s+стажир/i;
/** Слова-триггеры не считаются частью ФИО. */
const TRIGGER_WORD_RE = /^(?:увол|прош|стажир)/i;
const MENTION_RE = /\[USER=(\d+)\]([\s\S]*?)\[\/USER\]/i;
// Логин — отдельный токен: М/M + цифры, logist…, rop…, manager…
const LOGIN_RE = /(?<![\p{L}\d])([МMмm]\d{1,5}|logist\d*|rop\d*|manager\d+)(?![\p{L}\d])/iu;

/** BB-коды кроме [USER] — убрать; [BR] — перенос строки. */
function cleanText(text: string): string {
  return text
    .replace(/\[br\]/gi, '\n')
    .replace(/\[(?!\/?USER\b)\/?[A-Z]+(?:=[^\]]*)?\]/gi, '')
    .replace(/&nbsp;/g, ' ');
}

export function loginKeysOf(login: string): string[] {
  const l = login.replace(/[Мм]/g, 'm').toLowerCase();
  const m = /^m(\d+)$/.exec(l);
  if (m) {
    // «М070» (чат стажёров) — в Битриксе логин может быть без ведущего нуля: manager70. Ошибочное совпадение
    // отсекает nameConsistent (ФИО в строке не должно противоречить аккаунту).
    const n = String(Number(m[1]));
    return [...new Set([`manager${m[1]}`, l, `manager${n}`, `m${n}`])];
  }
  return [l];
}

export function parseAnnouncement(text: string): ParsedLine[] {
  const out: ParsedLine[] = [];
  // Чат стажёров: логин бывает отдельной строкой над ФИО («М137\nВоронина Екатерина не прошла стажировку») —
  // строку из одного логина приклеиваем к следующей.
  let pendingLogin: string | null = null;
  for (const raw of cleanText(text).split(/\r?\n/)) {
    let line = raw.trim();
    if (!line) continue;
    const onlyLogin = LOGIN_RE.exec(line);
    if (onlyLogin && onlyLogin[0].length === line.replace(/[\s.,:;—–-]+$/u, '').length && !DISMISS_RE.test(line)) { pendingLogin = onlyLogin[1]; continue; }
    if (pendingLogin && !LOGIN_RE.test(line)) line = `${pendingLogin} ${line}`;
    pendingLogin = null;
    if (!DISMISS_RE.test(line)) continue;
    const mention = MENTION_RE.exec(line);
    const mentionId = mention ? Number(mention[1]) || null : null;
    let rest = mention ? line.replace(MENTION_RE, ' ') : line;
    const lm = LOGIN_RE.exec(rest);
    const login = lm ? lm[1] : null;
    if (lm) rest = rest.slice(0, lm.index) + ' ' + rest.slice(lm.index + lm[0].length);
    // Имя: слова кириллицей с заглавной («уволен», «по собственному» — со строчной, отпадают).
    const words = (rest.match(/[А-ЯЁ][а-яё]+(?:-[А-ЯЁ]?[а-яё]+)?/g) ?? []).filter(w => !TRIGGER_WORD_RE.test(w));
    const name = words.length >= 2 && words.length <= 3 ? words.join(' ') : null;
    out.push({ line: line.replace(MENTION_RE, (_, _id, n) => String(n).trim()).trim(), mentionId, login, loginKeys: login ? loginKeysOf(login) : [], name });
  }
  return out;
}

const norm = (s: string) => s.toLowerCase().replace(/ё/g, 'е').trim();
/** Слова ФИО без пометок ЗАГЛАВНЫМИ («В ОТПУСКЕ», «УДАЛИТЬ») — как samePerson в lib/org/tenures.ts. */
const personWords = (s: string) => s.trim().split(/\s+/).filter(w => w && !/^[А-ЯЁA-Z]+$/.test(w)).map(norm);

/** «Фамилия Имя» из сообщения ровно совпадает с именем пользователя (порядок слов любой). */
export function exactName(written: string, userName: string): boolean {
  const a = personWords(written), b = personWords(userName);
  if (a.length < 2 || a.length !== b.length) return false;
  const set = new Set(b);
  return a.every(w => set.has(w));
}

/** Имя аккаунта не противоречит написанному: заглушка без кириллицы («Manager106») или тот же человек. */
export function nameConsistent(written: string | null, userName: string): boolean {
  if (!written) return true;
  if (!/[а-яё]/i.test(userName) || /^user\s*\d+$/i.test(userName.trim())) return true;
  const a = personWords(written), b = new Set(personWords(userName));
  return a.length > 0 && a.every(w => b.has(w));
}

export interface DirectoryUser { bitrixId: number; name: string; login: string | null; active: boolean }
export type Resolution =
  | { ok: true; bitrixId: number; via: 'mention' | 'login' | 'name' }
  | { ok: false; reason: string };

/**
 * Кто это: [USER=id] → логин (LOGIN Битрикса; при написанном ФИО — оно не должно противоречить аккаунту) →
 * точное «Фамилия Имя» среди пользователей Битрикса (ровно один). Иначе — не угадываем.
 */
export function resolveLine(p: ParsedLine, users: DirectoryUser[]): Resolution {
  if (p.mentionId) {
    return users.some(u => u.bitrixId === p.mentionId) ? { ok: true, bitrixId: p.mentionId, via: 'mention' } : { ok: false, reason: `пользователь #${p.mentionId} не найден` };
  }
  if (p.loginKeys.length) {
    const hits = users.filter(u => u.login && p.loginKeys.includes(u.login.toLowerCase()));
    const uniq = [...new Map(hits.map(u => [u.bitrixId, u])).values()];
    if (uniq.length === 1) {
      if (nameConsistent(p.name, uniq[0].name)) return { ok: true, bitrixId: uniq[0].bitrixId, via: 'login' };
      return { ok: false, reason: `на логине ${p.login} сейчас «${uniq[0].name}», а написано «${p.name}»` };
    }
    if (uniq.length > 1) return { ok: false, reason: `логин ${p.login} неоднозначен` };
  }
  if (p.name) {
    const hits = users.filter(u => exactName(p.name!, u.name));
    if (hits.length === 1) return { ok: true, bitrixId: hits[0].bitrixId, via: 'name' };
    if (hits.length > 1) return { ok: false, reason: `«${p.name}» — несколько сотрудников с таким именем` };
    return { ok: false, reason: p.login ? `ни логин ${p.login}, ни «${p.name}» не найдены` : `«${p.name}» не найден(а)` };
  }
  return { ok: false, reason: p.login ? `логин ${p.login} не найден` : 'нет ни упоминания, ни логина, ни имени' };
}
