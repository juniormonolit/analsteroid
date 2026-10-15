// «Похоже, это …» — подсказка типа клиента на «Обзоре» (идея владельца 15.10:
// «система сама подсказывает, что это за клиент, и предлагает менеджеру
// заполнить»). Правила владельца + ЕГРЮЛ (legalEntity.ts):
//   • юрлицо — скорее всего строительная организация; ОКВЭД уточняет:
//     раздел F (41–43) и проектирование → стройорганизация, «чем занимается» —
//     из названия ОКВЭДа; прочее → «под собственные нужды»;
//   • ИП со строительным ОКВЭДом → прораб (бригада);
//   • физлицо: объектов > 1 → строитель (прораб); 1 объект → строит себе;
//   • много разных товарных групп → «полный цикл стройки» (в «чем занимается»).
// Подсказка — только предложение: менеджер подтверждает одним нажатием или
// выбирает другой тип.

import type { ClientType, ModuleDeal } from './types';
import type { LegalEntity } from './legalEntity';

export interface ClientHint {
  type: ClientType;
  /** Предлагаемое «чем занимается» (для стройорганизации/прораба). */
  occupation: string;
  confidence: 'high' | 'medium' | 'low';
  /** Почему так решили — строки для менеджера. */
  reasons: string[];
  /** На что обратить внимание (ликвидирована и т.п.). */
  warnings: string[];
}

/** «Полный цикл»: столько разных товарных групп в отгрузках и больше. */
const FULL_CYCLE_GROUPS = 4;

const plural = (n: number, one: string, few: string, many: string) =>
  n % 10 === 1 && n % 100 !== 11 ? one : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) ? few : many;

export function clientHint(input: {
  entity: 'contact' | 'company';
  deals: ModuleDeal[];
  /** Доля сделок в юр. воронках (1/3). */
  legalShare: number;
  /** Объекты, кроме «адрес до города». */
  objects: number;
  legal: LegalEntity | null;
}): ClientHint {
  const { entity, deals, legalShare, objects, legal } = input;
  const reasons: string[] = [];
  const warnings: string[] = [];

  const groups = new Set<string>();
  for (const d of deals) if (d.deliveredAt) for (const g of d.groups) groups.add(g);
  const fullCycle = groups.size >= FULL_CYCLE_GROUPS;
  const cycleNote = fullCycle ? `${groups.size} разных товарных групп — похоже на полный цикл стройки` : null;

  if (legal) {
    if (legal.status === 'liquidated') warnings.push(`По ЕГРЮЛ ликвидирована${legal.liquidatedAt ? ` ${legal.liquidatedAt.split('-').reverse().join('.')}` : ''}`);
    else if (legal.status === 'liquidating') warnings.push('По ЕГРЮЛ в процессе ликвидации или банкротства');
    if (legal.registeredAt && Date.now() - new Date(legal.registeredAt).getTime() < 365 * 86_400_000) warnings.push('Зарегистрирована меньше года назад');
  }
  const okvedLine = legal?.okved ? `ОКВЭД ${legal.okved}${legal.okvedName ? ` — ${legal.okvedName}` : ''}` : null;

  // ИП со стройкой → прораб/бригада.
  if (legal?.kind === 'individual' && (legal.okvedKind === 'construction' || legal.okvedKind === 'design')) {
    reasons.push(`ИП, ${okvedLine}`);
    if (objects > 1) reasons.push(`${objects} ${plural(objects, 'объект', 'объекта', 'объектов')}`);
    if (cycleNote) reasons.push(cycleNote);
    return { type: 'foreman', occupation: fullCycle ? 'Полный цикл стройки' : legal.okvedName ?? '', confidence: 'high', reasons, warnings };
  }

  // ИП-торговец/риелтор — тоже по ветке юрлица (ОКВЭД говорит больше, чем «частник»).
  const isLegal = entity === 'company' || legal?.kind === 'legal' || legalShare > 0.5
    || (legal?.kind === 'individual' && (legal.okvedKind === 'building_trade' || legal.okvedKind === 'realty'));
  if (isLegal) {
    if (legal) {
      if (legal.okvedKind === 'construction' || legal.okvedKind === 'design') {
        reasons.push(okvedLine!);
        if (cycleNote) reasons.push(cycleNote);
        return { type: 'construction_org', occupation: fullCycle ? 'Полный цикл стройки' : legal.okvedName ?? '', confidence: 'high', reasons, warnings };
      }
      if (legal.okvedKind === 'realty') {
        reasons.push(`${okvedLine} — возможно, девелопер: уточни, строят ли сами`);
        return { type: 'construction_org', occupation: 'Девелопмент / недвижимость', confidence: 'low', reasons, warnings };
      }
      if (legal.okvedKind === 'building_trade') {
        reasons.push(`${okvedLine} — торгует стройматериалами, возможно перепродаёт`);
        return { type: 'construction_org', occupation: 'Торговля стройматериалами', confidence: 'low', reasons, warnings };
      }
      // Не строительный ОКВЭД. Но если возит на несколько объектов — всё-таки строят.
      reasons.push(`${okvedLine ?? 'ОКВЭД не указан'} — не строительный`);
      if (objects > 1 || fullCycle) {
        if (objects > 1) reasons.push(`но ${objects} ${plural(objects, 'объект', 'объекта', 'объектов')}`);
        if (cycleNote) reasons.push(cycleNote);
        return { type: 'construction_org', occupation: fullCycle ? 'Полный цикл стройки' : '', confidence: 'low', reasons, warnings };
      }
      return { type: 'own_needs_org', occupation: '', confidence: 'medium', reasons, warnings };
    }
    reasons.push(entity === 'company' ? 'Юрлицо (компания в Битриксе)' : 'Сделки в воронках юрлиц');
    reasons.push('ИНН в реквизитах Битрикса нет — ОКВЭД проверить не смогли');
    if (objects > 1) reasons.push(`${objects} ${plural(objects, 'объект', 'объекта', 'объектов')}`);
    if (cycleNote) reasons.push(cycleNote);
    return { type: 'construction_org', occupation: fullCycle ? 'Полный цикл стройки' : '', confidence: objects > 1 || fullCycle ? 'medium' : 'low', reasons, warnings };
  }

  // Физлицо.
  if (objects > 1) {
    reasons.push(`Частное лицо, но ${objects} ${plural(objects, 'объект', 'объекта', 'объектов')} — строит не только себе`);
    if (cycleNote) reasons.push(cycleNote);
    return { type: 'foreman', occupation: fullCycle ? 'Полный цикл стройки' : '', confidence: objects > 2 ? 'high' : 'medium', reasons, warnings };
  }
  reasons.push(objects === 1 ? 'Частное лицо, 1 объект' : 'Частное лицо, точного адреса объекта нет');
  if (cycleNote) reasons.push(`${groups.size} разных товарных групп — строит дом целиком`);
  return { type: 'self_builder', occupation: '', confidence: objects === 1 ? 'high' : 'medium', reasons, warnings };
}
