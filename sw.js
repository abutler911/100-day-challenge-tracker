/**
 * Offline shell.
 *
 * The tracker should open and show your last known progress on a phone with
 * no signal. Anything live (the database socket, auth) is deliberately left
 * alone so the service worker never sits between you and your data.
 */

const VERSION = "v1";
const SHELL = `shell-${VERSION}`;
const RUNTIME = `runtime-${VERSION}`;

const SHELL_FILES = [
  "./",
  "./index.html",
  "./assets/app.css",
  "./assets/app.js",
  "./assets/sync.js",
  "./assets/config.js",
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

  // Stale-while-revalidate: instant from cache, refreshed in the background.
  event.respondWith(
    caches.match(request).then((cached) => {
      const network = fetch(request)
        .then((response) => {
          if (response && (response.ok || response.type === "opaque")) {
            const copy = response.clone();
            caches.open(sameOrigin ? SHELL : RUNTIME).then((cache) => cache.put(request, copy));
          }
          return response;
        })
        .catch(() => cached);

      return cached || network;
    })
  );
});
