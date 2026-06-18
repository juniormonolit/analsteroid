import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Analsteroid',
  description: 'BI-аналитика продаж',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ru">
      <body>{children}</body>
    </html>
  );
}
