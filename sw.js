/* ════════════════════════════════════════════════════════════════════════════
   Evan-e-Hakimi & Qadri Hall Management — Production Service Worker
   Cache Version: hall-admin-v1.0.0
   Strategy:
     - API (/api/*): Network-Only, NEVER cached. Returns JSON on offline error.
     - HTML Navigations: Network-First. Falls back to /offline.html on network drop.
     - Static Assets (/assets/*, fonts): Stale-While-Revalidate / Cache-First.
════════════════════════════════════════════════════════════════════════════ */

const CACHE_NAME = 'hall-admin-v1.0.0';

const PRECACHE_ASSETS = [
  '/manifest.json',
  '/offline.html',
  '/assets/favicon.svg',
  '/assets/icon-192.png',
  '/assets/icon-512.png',
  '/assets/icon-192-maskable.png',
  '/assets/icon-512-maskable.png'
];

// Install: Pre-cache shell assets & activate immediately
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(PRECACHE_ASSETS);
    }).then(() => self.skipWaiting())
  );
});

// Activate: Clean up outdated caches & claim clients
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (key.startsWith('hall-admin-') && key !== CACHE_NAME) {
            return caches.delete(key);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

// Fetch handler
self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // 1. Only process GET requests; allow POST/PUT/PATCH/DELETE to pass straight through
  if (req.method !== 'GET') {
    return;
  }

  // 2. API Routes: ALWAYS Network-Only (NEVER cache live database, auth or financial data)
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(
      fetch(req).catch(() => {
        // Return structured JSON instead of HTML on network failure
        return new Response(
          JSON.stringify({
            error: 'Network connection unavailable. Please check your internet connection.',
            offline: true
          }),
          {
            status: 503,
            headers: { 'Content-Type': 'application/json' }
          }
        );
      })
    );
    return;
  }

  // 3. HTML Navigations (Root, /login, /admin, etc.): Network-First
  // Never show stale dashboard or stale login screens. If offline, serve /offline.html
  if (req.mode === 'navigate' || req.headers.get('accept')?.includes('text/html')) {
    event.respondWith(
      fetch(req).catch(async () => {
        const cache = await caches.open(CACHE_NAME);
        const cachedOffline = await cache.match('/offline.html');
        return cachedOffline || Response.error();
      })
    );
    return;
  }

  // 4. Static Assets (/assets/*, /js/*, fonts, CDN stylesheets): Stale-While-Revalidate
  const isStatic = (
    url.pathname.startsWith('/assets/') ||
    url.pathname.startsWith('/js/') ||
    url.hostname.includes('fonts.googleapis.com') ||
    url.hostname.includes('fonts.gstatic.com') ||
    url.hostname.includes('cdnjs.cloudflare.com')
  );

  if (isStatic) {
    event.respondWith(
      caches.match(req).then((cachedResponse) => {
        const fetchPromise = fetch(req).then((networkResponse) => {
          if (networkResponse && (networkResponse.status === 200 || networkResponse.type === 'opaque')) {
            const clone = networkResponse.clone();
            caches.open(CACHE_NAME).then((cache) => {
              cache.put(req, clone);
            });
          }
          return networkResponse;
        }).catch(() => null);

        // Return cached version if found, or wait for network
        return cachedResponse || fetchPromise;
      })
    );
    return;
  }

  // 5. Default fallback: regular network fetch
  event.respondWith(fetch(req));
});
