import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

// Vite root is the project root; the SPA entry is index.html which loads /client/main.tsx.
// The API is served by the Node server (server/index.ts) on PORT 8787 and proxied in dev.
export default defineConfig({
  build: { outDir: 'dist/client', emptyOutDir: true },
  server: {
    port: 5173,
    proxy: { '/api': 'http://localhost:8787' },
  },
  plugins: [
    react(),
    VitePWA({
      registerType: 'prompt',
      // The manifest link carries crossorigin="use-credentials", so the
      // browser sends credentials when it fetches the manifest.
      useCredentials: true,
      includeAssets: ['icon.svg', 'apple-touch-icon.png'],
      manifest: {
        id: '/',
        name: 'Subfeed',
        short_name: 'Subfeed',
        description: 'A distraction-free YouTube subscriptions reader',
        theme_color: '#0f0f0f',
        background_color: '#0f0f0f',
        display: 'standalone',
        start_url: '/',
        scope: '/',
        icons: [
          { src: 'pwa-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: 'pwa-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: 'pwa-512-maskable.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        navigateFallback: '/index.html',
        // These must reach the server, not the cached app shell.
        navigateFallbackDenylist: [/^\/api\//, /^\/healthz$/],
        runtimeCaching: [
          {
            // Thumbnails: cache-first so the feed renders offline.
            urlPattern: ({ url }) => url.hostname.endsWith('ytimg.com'),
            handler: 'CacheFirst',
            options: {
              cacheName: 'thumbnails',
              // Cross-origin thumbnails come back opaque (status 0). Each one
              // counts as several MB against quota, so keep the cache small.
              cacheableResponse: { statuses: [0, 200] },
              expiration: { maxEntries: 150, maxAgeSeconds: 7 * 86400, purgeOnQuotaError: true },
            },
          },
        ],
      },
    }),
  ],
})
