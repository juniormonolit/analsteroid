import type { NextConfig } from 'next';
import path from 'path';

// Internal BI tool, no third-party embeds/fonts/scripts (verified: no next/font remote,
// no <script> tags, no dangerouslySetInnerHTML in the codebase — see the 2026-07-08 security
// audit report). CSP ships Report-Only for now: the app relies on inline `style={{...}}`
// throughout, so style-src needs 'unsafe-inline'; script-src is kept without it since nothing
// requires inline scripts, but this hasn't been confirmed against a live run behind Caddy —
// flip to enforced (Content-Security-Policy) once confirmed no violations show up in prod.
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

const nextConfig: NextConfig = {
  output: 'standalone',
  turbopack: {
    root: path.resolve(__dirname),
  },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          {
            key: 'Permissions-Policy',
            value: 'camera=(), microphone=(), geolocation=(), interest-cohort=()',
          },
          // Caddy terminates TLS in front of this app (see lib/http/publicOrigin.ts) — safe
          // to assert HSTS. includeSubDomains/preload left off until subdomains are audited.
          { key: 'Strict-Transport-Security', value: 'max-age=15552000' },
          { key: 'Content-Security-Policy-Report-Only', value: CSP },
        ],
      },
    ];
  },
};

export default nextConfig;
