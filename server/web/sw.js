// BioPass — service worker : l'interface reste disponible hors connexion.
// Réseau d'abord : en ligne, on affiche toujours la dernière version déployée ; le cache
// ne sert que si le serveur ne répond pas (hors ligne, ou plus de 4 s).
// L'API n'est jamais mise en cache (les données chiffrées sont gérées par l'app).
const CACHE = 'biopass-v3';
const F = (f) => 'index.php?f=' + f;
const SHELL = [F('index.html'), ...['assets/app.js', 'assets/core.js', 'assets/icons.js', 'assets/style.css', 'icon.svg', 'icon-192.png', 'manifest.webmanifest'].map(F)];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))));
  self.clients.claim();
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.endsWith('/api.php')) return;
  if (url.searchParams.has('s')) return; // pages de partage (Send) : jamais dans le cache de l'application
  // Navigation (./, ./?k=…, index.php) → la page ; sinon le fichier exact (le paramètre f compte)
  const nav = e.request.mode === 'navigate';
  const key = nav ? new URL(F('index.html'), self.registration.scope).href : e.request;
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    try {
      const res = await Promise.race([
        fetch(e.request),
        new Promise((_, reject) => setTimeout(() => reject(new Error('délai')), 4000)),
      ]);
      if (res.ok) cache.put(key, res.clone()).catch(() => {});
      return res;
    } catch (err) {
      const cached = await cache.match(key);
      if (cached) return cached;
      throw err;
    }
  })());
});
