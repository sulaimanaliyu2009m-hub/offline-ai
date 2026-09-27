const CACHE = 'amiir-ai-shell-v2';
const SHELL = ['/', '/manifest.webmanifest', '/icon.svg'];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE)
      .then(cache => cache.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin ||
      url.pathname.startsWith('/api/') || url.pathname.startsWith('/generated/') || url.pathname === '/admin') {
    return;
  }

  event.respondWith((async () => {
    try {
      const response = await fetch(event.request);
      if (response.ok && SHELL.includes(url.pathname)) {
        const cache = await caches.open(CACHE);
        event.waitUntil(cache.put(event.request, response.clone()));
      }
      return response;
    } catch {
      return await caches.match(event.request) || await caches.match('/') ||
        new Response('Amiir AI needs a connection to load this page for the first time.', {
          status: 503,
          headers: { 'Content-Type': 'text/plain; charset=utf-8' },
        });
    }
  })());
});
