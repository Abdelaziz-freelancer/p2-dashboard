self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('push', e => {
  let d = {}; try { d = e.data ? e.data.json() : {}; } catch (x) {}
  e.waitUntil(self.registration.showNotification(d.title || 'إشعار جديد', { body: d.body || '', icon: '/icon-192.png', badge: '/icon-192.png', data: { url: d.url || '/' }, dir: 'rtl', lang: 'ar' }));
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || '/';
  e.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then(l => { for (const c of l) { if ('focus' in c) return c.focus(); } return clients.openWindow(url); }));
});
