// Оформление «ССП тест» — стиль сайта monolit.shop по макетам владельца
// (docs/design/monolitika-redesign-monolitshop-20261006, токены — 00-stil.html).
// Палитра, шрифт и выбранная тема — ОБЩИЕ с «Дашбордом» (features/dashboard-test/ui/theme.ts):
// одна страница владельца не должна отличаться от другой ни оттенком, ни шрифтом,
// поэтому здесь только реэкспорт, а не своя копия токенов.
export { C, FONT, FONT_FACES, THEME_CSS, readTheme, subscribeTheme, writeTheme, type ThemeName } from '@/features/dashboard-test/ui/theme';
