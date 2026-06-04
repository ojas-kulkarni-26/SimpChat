self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(clients.claim());
});

self.addEventListener('push', (event) => {
  let data = { title: 'SimpChat', body: '', icon: 'icon.svg', badge: 'icon.svg' };
  try {
    if (event.data) {
      data = Object.assign({}, data, event.data.json());
    }
  } catch (e) {}

  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: data.icon,
      badge: data.badge,
      tag: 'simpchat-message',
      data: data.data || {},
      vibrate: [200, 100, 200],
      silent: false,
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const swScope = self.location.origin + self.location.pathname.replace(/\/[^/]*$/, '/');
  const queryString = event.notification.data?.url || '';
  const urlToOpen = queryString ? swScope + queryString : swScope;

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
      for (const client of windowClients) {
        if (client.url.includes(self.location.origin) && 'focus' in client) {
          return client.focus();
        }
      }
      if (clients.openWindow) {
        return clients.openWindow(urlToOpen);
      }
    })
  );
});
