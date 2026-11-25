// Гейт «Сторожа» (дубль гейта раздела, layout делает поток A): директор и выше —
// superadmin / «Администратор» / роль «Директор» (решение владельца 25.11, BIG_BROTHER_SPEC.md).
export function canManageIdleWatch(
  session: { isSuperadmin: boolean; roleName: string | null } | null | undefined,
): boolean {
  return !!session && (session.isSuperadmin || session.roleName === 'Администратор' || session.roleName === 'Директор');
}
