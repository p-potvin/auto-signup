/**
 * Offline shell. Nothing else.
 *
 * The one rule this file exists to hold: **no vault data goes in Cache Storage.**
 * A cache outlives the tab, the session and a closed browser, and unlike the
 * in-memory session area it is readable by anything that can reach the origin's
 * storage. So this caches the static shell — HTML, JS, CSS, icons — and treats
 * every `/v1/` request as network-only, no fallback, no opportunistic caching.
 *
 * Losing the network means the app opens and says it cannot reach the vault,
 * which is the honest outcome. Item caching, if it is ever wanted, belongs in
 * IndexedDB under the master key, not here.
 */

export {};

declare const self: ServiceWorkerGlobalScope;

declare const __VW_VERSION__: string;

/**
 * Changes on every build.
 *
 * The cache name used to be the package version, which was wrong in a way that
 * only shows up after a deploy: the version does not move between builds, so
 * the name never changed, `activate` found nothing stale to delete, and
 * cache-first kept serving the previous `mobile.js` forever. A shipped fix
 * would simply not arrive.
 *
 * nginx sends this file `no-cache`, so the browser always re-fetches it, sees a
 * byte-different script, and installs the new worker — which is what makes a
 * changing name here sufficient.
 */
declare const __VW_BUILD__: string;

const CACHE = `vaultwares-shell-${__VW_VERSION__}-${__VW_BUILD__}`;

const SHELL = [
    './',
    './index.html',
    './mobile.js',
    './mobile.css',
    './manifest.webmanifest',
    './favicon.ico',
    './icons/icon-180.png',
    './icons/icon-192.png',
    './icons/icon-512.png',
    './icons/icon-maskable-512.png',
    './icons/favicon-16.png',
    './icons/favicon-32.png',
];

self.addEventListener('install', event => {
    event.waitUntil(
        caches.open(CACHE)
            // addAll is all-or-nothing, and one missing icon should not cost the
            // whole offline shell.
            .then(cache => Promise.allSettled(SHELL.map(url => cache.add(url))))
            .then(() => self.skipWaiting()),
    );
});

self.addEventListener('activate', event => {
    event.waitUntil(
        caches.keys()
            .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
            .then(() => self.clients.claim()),
    );
});

self.addEventListener('fetch', event => {
    const request = event.request;
    if (request.method !== 'GET') return;

    const url = new URL(request.url);

    // Vault traffic: straight to the network, and never stored. Left
    // unintercepted so a failure surfaces as the app's own error rather than a
    // synthesised response.
    if (url.origin !== self.location.origin || url.pathname.startsWith('/v1/')) return;

    // Shell: cache first. These are content-versioned by the cache name, so a
    // stale copy can only exist between a deploy and the next activate.
    event.respondWith(
        caches.match(request).then(hit => hit ?? fetch(request).then(response => {
            if (response.ok && response.type === 'basic') {
                const copy = response.clone();
                void caches.open(CACHE).then(cache => cache.put(request, copy));
            }
            return response;
        }).catch(() => caches.match('./index.html').then(fallback => fallback ?? Response.error()))),
    );
});
