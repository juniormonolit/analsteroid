// Авто-подстановка роли по маске логина при создании аккаунта (owners-инструкция
// 10.07.2026). Работает ТОЛЬКО как дефолт — заполняет поле в форме/API, если роль
// не выбрана явно; явный выбор (в UI — селект роли, в API — переданный role_id)
// всегда побеждает. Регистр логина не важен.
//
// Правила (первое совпадение побеждает — порядок важен, «rop» проверяется ПОСЛЕ
// «manager», чтобы не задеть, например, login'ы вида managerrop*):
//   login начинается с "manager"      → МОП
//   login содержит "rop" (не manager*) → РОП
//   login начинается с "log"           → Логист
//   иначе                              → Пользователь (заглушка, permissions '{}')

export type AutoRoleName = 'МОП' | 'РОП' | 'Логист' | 'Пользователь';

export function resolveRoleNameByLogin(login: string): AutoRoleName {
  const l = login.trim().toLowerCase();
  if (l.startsWith('manager')) return 'МОП';
  if (l.includes('rop')) return 'РОП';
  if (l.startsWith('log')) return 'Логист';
  return 'Пользователь';
}
