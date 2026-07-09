import type { Metadata, Viewport } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Монолитика',
  description: 'BI-аналитика продаж',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  // viewportFit=cover — чтобы работали env(safe-area-inset-*) на iPhone с вырезом
  viewportFit: 'cover',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ru">
      <body>{children}</body>
    </html>
  );
}
