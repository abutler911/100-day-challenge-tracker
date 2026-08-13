/**
 * Offline shell.
 *
 * The tracker should open and show your last known progress on a phone with
 * no signal. Anything live (the database socket, auth) is deliberately left
 * alone so the service worker never sits between you and your data.
 */

/* Bump on every release that changes a shell file. The caches below are keyed
   by it, so a bump is what evicts stale copies — without one, a deploy can be
   served from the previous version's cache for a load or more. */
const VERSION = "v2";
const SHELL = `shell-${VERSION}`;
const RUNTIME = `runtime-${VERSION}`;

const SHELL_FILES = [
  "./",
  "./index.html",
  "./assets/app.css",
  "./assets/app.js",
  "./assets/sync.js",
  "./assets/config.js",
  "./assets/theme.js",
  "./manifest.webmanifest",
  "./assets/icons/icon.svg",
  "./assets/icons/icon-192.png",
  "./assets/icons/apple-touch-icon.png",
];

/** Hosts we cache opportunistically: fonts and the versioned Firebase SDK. */
const CACHEABLE_HOSTS = new Set([
  "fonts.googleapis.com",
  "fonts.gstatic.com",
  "www.gstatic.com",
]);

/** Live traffic: never intercepted. */
function isLive(url) {
  return (
    url.hostname.endsWith("firebaseio.com") ||
    url.hostname.endsWith("firebasedatabase.app") ||
    url.hostname.endsWith("googleapis.com") ||
    url.hostname.endsWith("firebaseapp.com")
  );
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(SHELL)
      // addAll is all-or-nothing; a single 404 would sink the install.
      .then((cache) => Promise.allSettled(SHELL_FILES.map((f) => cache.add(f))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== SHELL && k !== RUNTIME).map((k) => caches.delete(k)))
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (isLive(url)) return;

  // Navigations: fresh when possible, cached when not.
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(SHELL).then((cache) => cache.put("./index.html", copy));
          return response;
        })
        .catch(() => caches.match("./index.html").then((hit) => hit || Response.error()))
    );
    return;
  }

  const sameOrigin = url.origin === self.location.origin;
  if (!sameOrigin && !CACHEABLE_HOSTS.has(url.hostname)) return;

  // Our own code and styles: network first, cache only as the offline
  // fallback. Stale-while-revalidate would serve the previous deploy's copy
  // for a load after every release — which is how a filled-in config.js can
  // still read as empty and drop the app into local-only mode.
  if (sameOrigin) {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response && response.ok) {
            const copy = response.clone();
            caches.open(SHELL).then((cache) => cache.put(request, copy));
          }
          return response;
        })
        .catch(() => caches.match(request).then((hit) => hit || Response.error()))
    );
    return;
  }

  // Fonts and the version-pinned Firebase SDK never change under a given URL,
  // so serve those from cache and refresh in the background.
  event.respondWith(
    caches.match(request).then((cached) => {
      const network = fetch(request)
        .then((response) => {
          if (response && (response.ok || response.type === "opaque")) {
            const copy = response.clone();
            caches.open(RUNTIME).then((cache) => cache.put(request, copy));
          }
          return response;
        })
        // Nothing cached and the network refused: `cached` is undefined here,
        // and resolving respondWith with undefined makes the browser fail the
        // request outright rather than letting it fall back. A browser that
        // blocks Google Fonts hits this on every face.
        .catch(() => cached || Response.error());

      return cached || network;
    })
  );
});
