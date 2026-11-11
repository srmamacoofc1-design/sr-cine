self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", event => event.waitUntil(self.clients.claim()));
self.addEventListener("fetch", event => {
  if (event.request.mode !== "navigate" || new URL(event.request.url).origin !== self.location.origin) return;
  event.respondWith(fetch(event.request).catch(() => new Response(
    '<!doctype html><html lang="pt-BR"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>sr.cine</title><body style="background:#111012;color:#fff;font:1rem system-ui;padding:2rem"><h1>sr.cine</h1><p>Conecte-se à internet para abrir o catálogo.</p><a style="color:#ff693b" href="./">Tentar de novo</a></body></html>',
    { headers: { "Content-Type": "text/html; charset=utf-8" } }
  )));
});
