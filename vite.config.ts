import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'
import path from 'node:path'

export default defineConfig({
  resolve: {
    alias: { '@': path.resolve(__dirname, './src') },
  },
  plugins: [
    react(),
    VitePWA({
      registerType: 'prompt',
      // injectManifest (not the default generateSW) — this is the standard
      // fix for vite-plugin-pwa + firebase-messaging: a background push
      // handler (onBackgroundMessage) must be custom SW code, and generateSW
      // does not let you inject any. src/sw.ts is our own source; it both
      // precaches the app shell (same file set this used to list under a
      // `workbox.globPatterns` block, now `injectManifest.globPatterns`
      // below) and registers Firebase Messaging's background handler. See
      // src/sw.ts's header for the full rationale.
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.ts',
      injectManifest: {
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
      },
      includeAssets: ['favicon.svg', 'apple-touch-icon.png'],
      manifest: {
        name: "Rosalia's Kitchen Staff Hub",
        short_name: 'RK Staff Hub',
        description:
          'Scheduling, availability, time clock, tips, tasks and HR for Rosalia’s Kitchen.',
        theme_color: '#FFFFFF',
        background_color: '#FFFFFF',
        display: 'standalone',
        orientation: 'portrait',
        start_url: '/',
        scope: '/',
        icons: [
          { src: 'pwa-192x192.png', sizes: '192x192', type: 'image/png' },
          { src: 'pwa-512x512.png', sizes: '512x512', type: 'image/png' },
          {
            src: 'pwa-512x512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
      // `injectManifest`'s dev-mode SW (module type) so background push can
      // actually be exercised against `npm run dev`, not just a production
      // build. vite-plugin-pwa's dev SW here is a thin pass-through — it does
      // not precache anything in dev, so this does not risk serving stale
      // bundles during development.
      devOptions: { enabled: true, type: 'module' },
      // Registration is done explicitly via `virtual:pwa-register` in
      // src/main.tsx rather than the plugin's auto-injected <script>/HMR-round
      // -trip flow. The auto-inject dev path (no `virtual:pwa-register` import
      // in app code) round-trips through Vite's WebSocket HMR channel to learn
      // devOptions.type before calling navigator.serviceWorker.register(),
      // which is fragile against stale/prior registrations at the same scope
      // and produced repeated "ServiceWorker script evaluation failed" dev
      // console errors. Calling registerSW() ourselves uses workbox-window's
      // Workbox wrapper directly, in both dev (devOptions.enabled routes it to
      // the same real registration template used in production, targeting
      // dev-sw.js) and production — one consistent, documented code path.
      injectRegister: false,
    }),
  ],
  server: { port: 5173, host: true },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./tests/setup.ts'],
    include: ['tests/**/*.test.{ts,tsx}', 'src/**/*.test.{ts,tsx}'],
    exclude: ['tests/rules/**'],
  },
})
