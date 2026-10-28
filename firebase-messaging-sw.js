importScripts('https://www.gstatic.com/firebasejs/12.15.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/12.15.0/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey: "AIzaSyD67E8efC3xhu2Uavp3htKhDnOjZDkRz94",
  authDomain: "baraka-gp.firebaseapp.com",
  projectId: "baraka-gp",
  storageBucket: "baraka-gp.firebasestorage.app",
  messagingSenderId: "708826047607",
  appId: "1:708826047607:web:0b1c85defdc1a157f5d272"
});

const messaging = firebase.messaging();

// Notification façon messagerie (nom de l'expéditeur + aperçu du message),
// jamais une bannière générique style "votre chauffeur arrive".
messaging.onBackgroundMessage((payload) => {
  const data = payload.data || {};
  const title = data.title || 'Baraka GP';
  const body = data.body || '';
  self.registration.showNotification(title, {
    body,
    icon: 'icons/icon-192.png',
    badge: 'icons/icon-192.png',
    tag: data.tag || undefined,
    data: { url: data.url || './index.html' }
  });
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || './index.html';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
      for (const client of windowClients) {
        if ('focus' in client) return client.focus();
      }
      if (clients.openWindow) return clients.openWindow(url);
    })
  );
});
