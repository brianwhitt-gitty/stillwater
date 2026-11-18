/*
  Stillwater: cross-origin isolation helper.

  GitHub Pages can't send the two headers that let a page use several processor
  cores for the voice engine (Cross-Origin-Opener-Policy and
  Cross-Origin-Embedder-Policy). This tiny service worker adds them to the
  page's own files as they load. It doesn't store, read or send anything:
  every request goes to the same place it was going, unchanged apart from
  those headers.

  The same file runs in two places: in the page (to register itself) and as
  the service worker (to add the headers).
*/
if (typeof window === "undefined") {
  // ---- Service worker ----
  self.addEventListener("install", () => self.skipWaiting());
  self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
  self.addEventListener("fetch", (event) => {
    const req = event.request;
    if (req.cache === "only-if-cached" && req.mode !== "same-origin") return;
    // Only this site's own files get the headers; anything else is left alone.
    if (new URL(req.url).origin !== self.location.origin) return;
    event.respondWith(
      fetch(req).then((res) => {
        if (res.status === 0) return res;
        const headers = new Headers(res.headers);
        headers.set("Cross-Origin-Embedder-Policy", "require-corp");
        headers.set("Cross-Origin-Opener-Policy", "same-origin");
        headers.set("Cross-Origin-Resource-Policy", "same-origin");
        return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
      })
    );
  });
} else {
  // ---- Page ----
  (() => {
    if (window.crossOriginIsolated || !window.isSecureContext || !navigator.serviceWorker) return;
    const src = document.currentScript && document.currentScript.src;
    if (!src) return;
    navigator.serviceWorker.register(src).then((reg) => {
      const reloadOnce = () => {
        // Reload one time so the page loads with the headers. window.name guards against a loop
        // in browsers that won't let the worker take over (it is not storage and holds no content).
        if (window.name === "stillwater-coi") return;
        window.name = "stillwater-coi";
        window.location.reload();
      };
      if (navigator.serviceWorker.controller) {
        // Controlled but not isolated: nothing more to do (the browser doesn't support it).
        return;
      }
      if (reg.active) { reloadOnce(); return; }
      const worker = reg.installing || reg.waiting;
      if (worker) worker.addEventListener("statechange", () => { if (worker.state === "activated") reloadOnce(); });
    }).catch(() => { /* Without the helper the voice still works, just on one core. */ });
  })();
}
