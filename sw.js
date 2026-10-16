/* H1.9.2: installability helper. Network-only: no caching of club data, auth or source files. */
self.addEventListener('install', function(){ self.skipWaiting(); });
self.addEventListener('activate', function(event){ event.waitUntil(self.clients.claim()); });
self.addEventListener('fetch', function(event){
  if(event.request.method !== 'GET') return;
  var url=new URL(event.request.url);
  if(url.origin !== self.location.origin) return;
  // Always fetch from network; never cache personal golf scores or auth data.
  event.respondWith(fetch(event.request));
});
