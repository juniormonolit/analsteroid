// Роли в расшифровке звонка: распознавание (va.transcriptions.formatted_dialogue) иногда размечает
// «Менеджер:/Клиент:», а иногда — безлико «Спикер 1:/Спикер 2:». РОПы (собрание 18.11): «поменять
// Спикер 1 / Спикер 2 на Менеджер / Клиент». Кто из спикеров менеджер — определяем так:
//   (а) по словам: в репликах менеджера бывает «Монолит», «меня зовут», «компания», «вас беспокоит»…;
//   (б) не решилось словами — по направлению: исходящий — первым говорит клиент («Алло»),
//       входящий — первым говорит менеджер (приветствие компании).
// Чистая функция, без БД: её же применяют вкладка «Звонки» канбана больших чеков и «ИИ-анализ».

export type SpeakerRole = 'manager' | 'client';

export interface SpeakerLine {
  /** null — у строки нет метки спикера (продолжение реплики) или спикер не определён. */
  role: SpeakerRole | null;
  /** Исходная метка («Спикер 3», «Менеджер»), null — метки нет. Нужна, когда role не определена. */
  speaker: string | null;
  /** Текст реплики без метки. */
  text: string;
}

// Метка бывает с отметкой времени: «Спикер 1 [00:12]: …» (raw_text распознавания, прод 18.11) — время отрезаем.
const LABEL_RE = /^\s*"?(Менеджер|Клиент|Спикер\s*\d+)"?\s*(?:[\[(]\s*\d{1,2}:\d{2}(?::\d{2})?\s*[\])])?\s*[:：]\s*/i;

/** Признаки менеджера (самопредставление, компания). Вес — сколько «очков» даёт совпадение. */
const MANAGER_HINTS: [RegExp, number][] = [
  [/монолит/i, 3],
  [/меня зовут/i, 2],
  [/вас беспокоит/i, 2],
  [/компани[яию]/i, 1],
  [/менеджер/i, 1],
  [/по вашей заявке/i, 2],
  [/отдел продаж/i, 2],
  [/звоню (вам )?(по|насч[её]т|уточнить)/i, 1],
  [/коммерческ(ое|ого) предложени/i, 1],
  // Живые звонки 18.11 (бордюры, Мясникова): менеджер предлагает и обещает действия.
  [/в наличии/i, 1],
  [/могу вам/i, 1],
  [/(пришлю|вышлю|отправлю|скину) вам|я вам (прислал|отправил|скинул|выслал)/i, 1],
  [/сейчас уточню|уточню и (перезвоню|наберу)/i, 1],
];

const normLabel = (s: string) => s.replace(/\s+/g, ' ').replace(/^./, c => c.toUpperCase()).trim();

/** Разметить строки расшифровки ролями. Строк на выходе ровно столько же, сколько в text.split('\n'). */
/** Есть ли в тексте метки спикеров (тогда показываем репликами, даже если formatted_dialogue пуст). */
export const hasSpeakerLabels = (text: string | null | undefined) => !!text && text.split('\n').some(ln => LABEL_RE.test(ln));

/** managerName — имя менеджера звонка: спикер, который ОБРАЩАЕТСЯ к нему по имени («Да, Карина, …»), — клиент. */
export function labelSpeakers(text: string, direction: string | null, managerName?: string | null): SpeakerLine[] {
  const parsed = text.split('\n').map(ln => {
    const m = ln.match(LABEL_RE);
    return m ? { speaker: normLabel(m[1]), text: ln.slice(m[0].length) } : { speaker: null as string | null, text: ln };
  });

  // Имя менеджера (части ≥ 3 букв): «Карина» в чужой реплике — обращение к менеджеру.
  const nameRes = (managerName ?? '').split(/\s+/).filter(w => w.length >= 3 && /^[А-ЯЁ]/.test(w))
    .map(w => new RegExp(`(^|[^а-яё])${w.replace(/[.*+?^${}()|[\]\\]/g, '')}([^а-яё]|$)`, 'i'));
  // Безликие спикеры в порядке первого появления.
  const order: string[] = [];
  const score = new Map<string, number>();
  for (const p of parsed) {
    if (!p.speaker || !/^Спикер/i.test(p.speaker)) continue;
    if (!order.includes(p.speaker)) order.push(p.speaker);
    let s = score.get(p.speaker) ?? 0;
    for (const [re, w] of MANAGER_HINTS) if (re.test(p.text)) s += w;
    for (const re of nameRes) if (re.test(p.text) && !/меня зовут|это\s+\S+\s*,|на связи/i.test(p.text)) s -= 2;
    score.set(p.speaker, s);
  }

  const roleOf = new Map<string, SpeakerRole>();
  if (order.length >= 1) {
    let manager: string | null = null;
    // (а) по словам: явный лидер по очкам.
    const ranked = [...order].sort((a, b) => (score.get(b) ?? 0) - (score.get(a) ?? 0));
    const top = score.get(ranked[0]) ?? 0, second = ranked.length > 1 ? score.get(ranked[1]) ?? 0 : 0;
    if (top > 0 && top > second) manager = ranked[0];
    // Лидера нет, но один из двух явно обращается к менеджеру по имени — менеджер второй.
    else if (order.length >= 2 && Math.min(score.get(order[0]) ?? 0, score.get(order[1]) ?? 0) < 0 && (score.get(order[0]) ?? 0) !== (score.get(order[1]) ?? 0))
      manager = (score.get(order[0]) ?? 0) > (score.get(order[1]) ?? 0) ? order[0] : order[1];
    // (б) по направлению: исходящий — первым «Алло» говорит клиент; входящий — первым менеджер.
    else if (order.length >= 2 && direction === 'outbound') manager = order[1];
    else if (direction === 'inbound') manager = order[0];
    // Направление неизвестно и слов нет — не гадаем: остаётся «Спикер N».
    if (manager) {
      roleOf.set(manager, 'manager');
      // Клиент — второй из двух главных спикеров (третий и дальше — без роли: перевод звонка, автоответчик).
      const client = order.slice(0, 2).find(s => s !== manager);
      if (client) roleOf.set(client, 'client');
    }
  }

  return parsed.map(p => {
    if (!p.speaker) return { role: null, speaker: null, text: p.text };
    if (/^Менеджер$/i.test(p.speaker)) return { role: 'manager', speaker: p.speaker, text: p.text };
    if (/^Клиент$/i.test(p.speaker)) return { role: 'client', speaker: p.speaker, text: p.text };
    return { role: roleOf.get(p.speaker) ?? null, speaker: p.speaker, text: p.text };
  });
}

export const ROLE_LABEL: Record<SpeakerRole, string> = { manager: 'Менеджер', client: 'Клиент' };
