/* Offline support. Network first for the pages and the small data files, so a deploy shows on the next load; the
   cached copy answers only when the network fails. The large card and combo files are not cached here: the pages keep
   them in IndexedDB already. */
'use strict';
const CACHE = 'edhgen-v1';
const SHELL = ['./', 'index.html', 'card.html', 'manifest.webmanifest', 'icons/icon-192.png', 'data/index.json', 'data/aliases.json', 'data/rarity.json', 'data/spellbook/manifest.json'];
const cacheable = u => u.origin === self.location.origin && (/\/(?:index|card)\.html$|\/$|\.webmanifest$|\/icons\//.test(u.pathname) || /\/data\/(?:index|aliases|rarity)\.json$|\/data\/spellbook\/manifest\.json$/.test(u.pathname));

self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).catch(() => {}).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', e => {
  const r = e.request, u = new URL(r.url);
  if (r.method !== 'GET' || !cacheable(u)) return;
  const key = u.origin + u.pathname; // one entry per file, whatever the query string
  e.respondWith(fetch(r).then(res => {
    if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(key, copy)); }
    return res;
  }).catch(() => caches.match(key).then(hit => hit || caches.match(u.pathname.endsWith('/') ? new URL('index.html', u).href : key)).then(hit => hit || Response.error())));
});
