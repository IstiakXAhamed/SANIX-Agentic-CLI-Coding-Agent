import type { NextConfig } from 'next';

/**
 * Next.js 16 config for @sanix/dashboard.
 *
 * - output: 'standalone' — produces a self-contained .next/standalone bundle
 *   so the dashboard can be run independently of the SANIX monorepo.
 * - The dashboard is pure client-side: every page talks to the SANIX REST API
 *   (default http://127.0.0.1:7331) using a browser fetch + Bearer token from
 *   localStorage. No server actions, no SSR data fetching.
 */
const config: NextConfig = {
  output: 'standalone',
  reactStrictMode: true,
  // Allow the dashboard's webpack dev server to proxy nothing — all data
  // fetching is direct browser → REST API. CORS must be enabled on the
  // SANIX server (`sanix serve --cors`).
  typescript: {
    ignoreBuildErrors: false,
  },
};

export default config;
