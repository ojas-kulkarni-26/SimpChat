const params = new URLSearchParams(self.location.search);
const SUPABASE_REST = (params.get('url') || '').replace(/\/$/, '') + '/rest/v1';
const SUPABASE_KEY = params.get('key') || '';

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(clients.claim());
});

self.addEventListener('push', (event) => {
  event.waitUntil(
    (async () => {
      let title = 'SimpChat';
      let body = '';

      if (!SUPABASE_REST || !SUPABASE_KEY) {
        await self.registration.showNotification(title, { body: 'New message', icon: 'icon.svg', tag: 'simpchat-push' });
        return;
      }

      try {
        const res = await fetch(SUPABASE_REST + '/messages?select=sender,content,msg_type&order=id.desc&limit=1', {
          headers: { apikey: SUPABASE_KEY },
        });
        const msgs = await res.json();
        if (msgs && msgs.length > 0) {
          title = msgs[0].sender || 'SimpChat';
          body = msgs[0].msg_type === 'image' ? '📷 Image' : (msgs[0].content || '').substring(0, 200);
        }
      } catch (e) {
        body = 'New message';
      }

      const swScope = self.location.origin + self.location.pathname.replace(/\/[^/]*$/, '/');
      const friend = title === 'Arnav' ? 'Ojas' : 'Arnav';

      await self.registration.showNotification(title, {
        body,
        icon: 'icon.svg',
        badge: 'icon.svg',
        tag: 'simpchat-push',
        data: { url: '?name=' + friend },
        vibrate: [200, 100, 200],
      });
    })()
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
