(() => {
  async function removeOldWebAppState() {
    if ("serviceWorker" in navigator) {
      try {
        const registrations = await navigator.serviceWorker.getRegistrations();
        await Promise.allSettled(
          registrations.map((registration) => {
            const scriptUrl =
              registration?.active?.scriptURL ||
              registration?.waiting?.scriptURL ||
              registration?.installing?.scriptURL ||
              "";
            if (String(scriptUrl).endsWith("/sw.js")) {
              return Promise.resolve(false);
            }
            return registration.unregister();
          })
        );
      } catch (error) {
        console.warn("Service worker cleanup failed:", error);
      }
    }

    if ("caches" in window) {
      try {
        const keys = await caches.keys();
        await Promise.allSettled(keys.map((key) => caches.delete(key)));
      } catch (error) {
        console.warn("Cache cleanup failed:", error);
      }
    }

    try {
      const staleKeys = [];
      for (let i = 0; i < localStorage.length; i += 1) {
        const key = localStorage.key(i);
        if (!key) continue;
        if (key.startsWith("static:") || key.endsWith(":meta")) {
          staleKeys.push(key);
        }
      }
      staleKeys.forEach((key) => localStorage.removeItem(key));
    } catch (error) {
      console.warn("Local storage cleanup failed:", error);
    }
  }

  window.addEventListener("load", () => {
    void removeOldWebAppState();
  });
})();
