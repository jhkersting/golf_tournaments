self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

function resolveUrl(url) {
  return new URL(String(url || "./scoreboard.html"), self.registration.scope).href;
}

self.addEventListener("push", (event) => {
  let data = {};
  if (event.data) {
    try {
      data = event.data.json();
    } catch (_) {
      data = { body: event.data.text() };
    }
  }

  const title = String(data.title || "Golf Tournament").trim() || "Golf Tournament";
  const body = String(data.body || "New scores were posted.").trim() || "New scores were posted.";
  const targetUrl = resolveUrl(data.url || "./scoreboard.html");

  event.waitUntil(
    (async () => {
      await self.registration.showNotification(title, {
        body,
        icon: new URL("./icons/icon-192.png", self.registration.scope).href,
        badge: new URL("./icons/icon-192.png", self.registration.scope).href,
        data: {
          url: targetUrl,
          tid: data.tid || null,
          roundIndex: data.roundIndex ?? null,
          mode: data.mode || null,
          holeIndex: data.holeIndex ?? null
        },
        tag: String(data.tag || "").trim() || undefined,
        renotify: true
      });

      if (data.mode !== "chat") return;

      const windows = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true
      });

      await Promise.all(
        windows.map(async (client) => {
          try {
            client.postMessage({
              type: "chat-notification",
              notification: {
                title,
                body,
                url: targetUrl,
                tid: data.tid || null,
                messageId: data.messageId || null,
                createdAt: data.createdAt ?? null,
                tag: String(data.tag || "").trim() || null
              }
            });
          } catch (_) {
            // Ignore clients that cannot receive messages.
          }
        })
      );
    })()
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();

  const targetUrl = resolveUrl(event.notification?.data?.url || "./scoreboard.html");
  const target = new URL(targetUrl);

  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true
      });

      for (const client of windows) {
        try {
          const clientUrl = new URL(client.url);
          if (clientUrl.origin === target.origin && clientUrl.pathname === target.pathname) {
            await client.focus();
            return;
          }
        } catch (_) {
          // ignore malformed URLs
        }
      }

      if (self.clients.openWindow) {
        await self.clients.openWindow(targetUrl);
      }
    })()
  );
});
