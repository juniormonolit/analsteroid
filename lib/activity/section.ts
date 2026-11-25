// Раздел Монолитики по пути: первый сегмент ('/tasker/12' → 'tasker', '/' → 'home');
// встроенные страницы Битрикса — два сегмента ('/bx/manager' → 'bx/manager').
export function sectionOfPath(path: string): string {
  const seg = path.split('?')[0].split('/').filter(Boolean);
  if (!seg.length) return 'home';
  if (seg[0] === 'bx' && seg[1]) return `bx/${seg[1]}`.slice(0, 60);
  return seg[0].slice(0, 60);
}
