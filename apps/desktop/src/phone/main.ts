/**
 * The phone page's entry (M6, F26): wires the browser's real fetch, storage and timers into the controller. Served by
 * the core's PhoneServer from the folder the desktop app passes as `phone.staticDir` (built by the `huddlePhonePage`
 * plugin in electron.vite.config.ts into out/phone).
 */
import './phone.css';
import { PhoneApp, type FetchLike, type StorageLike } from './app.js';

function storage(): StorageLike | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

const root = document.getElementById('app');
if (root !== null) {
  const fetchFn: FetchLike = (url, init) => window.fetch(url, init);
  const app = new PhoneApp({
    doc: document,
    root,
    fetch: fetchFn,
    storage: storage(),
    setTimeout: (fn, ms) => window.setTimeout(fn, ms),
    clearTimeout: (handle) => {
      window.clearTimeout(handle as number);
    },
    random: Math.random,
    userAgent: navigator.userAgent,
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') app.wake();
  });
  window.addEventListener('online', () => {
    app.wake();
  });
  app.start();
}
