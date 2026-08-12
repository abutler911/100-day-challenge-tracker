/**
 * Sync layer.
 *
 * Two interchangeable backends behind one interface:
 *
 *   createSync({ config, roomId, onState, onStatus })
 *     -> { setDay(day, on), clearAll(), destroy() }
 *
 *   - Firebase Realtime Database when config is filled in. Shared across
 *     devices, live, no refresh needed.
 *   - localStorage otherwise, so an unconfigured deploy still works (and
 *     still syncs across tabs on the same device).
 *
 * State is a plain object of marked days: { "1": 1755057600000, "7": ... }
 * where the value is the timestamp it was marked. Absent means unmarked.
 *
 * Writes are optimistic. Each one goes into a pending queue that is persisted
 * to localStorage before the network is touched, so a write made in a dead
 * zone survives a reload and replays on reconnect.
 */

const FIREBASE_VERSION = "12.17.1";
const cdn = (mod) => `https://www.gstatic.com/firebasejs/${FIREBASE_VERSION}/firebase-${mod}.js`;

const cacheKey = (room) => `savings100:cache:${room}`;
const pendingKey = (room) => `savings100:pending:${room}`;

export function isConfigured(config) {
  return Boolean(config && config.apiKey && config.databaseURL && config.projectId);
}

/* -------------------------------------------------------------------------
   Local persistence helpers
   ------------------------------------------------------------------------- */

function readJSON(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function writeJSON(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* private mode or quota; in-memory state still works for this session */
  }
}

/**
 * Overlay unconfirmed local writes on top of the last known server state, so
 * the UI reflects what you just tapped even before the server agrees.
 */
function merge(remote, pending) {
  const out = { ...remote };
  for (const [day, entry] of Object.entries(pending)) {
    if (entry.on) out[day] = entry.at;
    else delete out[day];
  }
  return out;
}

/* -------------------------------------------------------------------------
   Local-only backend
   ------------------------------------------------------------------------- */

function createLocalSync({ roomId, onState, onStatus, reason }) {
  const key = cacheKey(roomId);
  let state = readJSON(key, {});

  const emit = () => onState({ ...state });

  const onStorage = (event) => {
    if (event.key !== key) return;
    state = readJSON(key, {});
    emit();
  };
  window.addEventListener("storage", onStorage);

  onStatus({ mode: "local", state: "local", reason });
  queueMicrotask(emit);

  const commit = () => {
    writeJSON(key, state);
    emit();
  };

  return {
    setDay(day, on) {
      if (on) state[day] = Date.now();
      else delete state[day];
      commit();
    },
    clearAll() {
      state = {};
      commit();
    },
    destroy() {
      window.removeEventListener("storage", onStorage);
    },
  };
}

/* -------------------------------------------------------------------------
   Firebase Realtime Database backend
   ------------------------------------------------------------------------- */

async function createFirebaseSync({ config, roomId, onState, onStatus }) {
  onStatus({ mode: "remote", state: "connecting" });

  const [{ initializeApp }, { getAuth, signInAnonymously }, database] = await Promise.all([
    import(/* @vite-ignore */ cdn("app")),
    import(/* @vite-ignore */ cdn("auth")),
    import(/* @vite-ignore */ cdn("database")),
  ]);

  const { getDatabase, ref, onValue, set, remove, off } = database;

  const app = initializeApp(config);
  await signInAnonymously(getAuth(app));

  const db = getDatabase(app);
  const daysRef = ref(db, `rooms/${roomId}/days`);
  const connRef = ref(db, ".info/connected");

  // Paint immediately from the last snapshot we saw, so a cold start on a
  // phone shows real numbers instead of zeros while the socket opens.
  let remote = readJSON(cacheKey(roomId), {});
  let pending = readJSON(pendingKey(roomId), {});
  let connected = false;

  const emit = () => onState(merge(remote, pending));
  const savePending = () => writeJSON(pendingKey(roomId), pending);

  const reportStatus = () => {
    const queued = Object.keys(pending).length;
    if (!connected) onStatus({ mode: "remote", state: "offline", queued });
    else if (queued) onStatus({ mode: "remote", state: "syncing", queued });
    else onStatus({ mode: "remote", state: "synced", queued: 0 });
  };

  queueMicrotask(emit);

  const unsubDays = onValue(daysRef, (snap) => {
    remote = snap.val() || {};
    writeJSON(cacheKey(roomId), remote);
    emit();
  });

  const unsubConn = onValue(connRef, (snap) => {
    const wasConnected = connected;
    connected = snap.val() === true;
    reportStatus();
    if (connected && !wasConnected) flush();
  });

  /** Push a single pending entry; drop it from the queue once it lands. */
  async function push(day) {
    const entry = pending[day];
    if (!entry) return;
    const target = ref(db, `rooms/${roomId}/days/${day}`);
    if (entry.on) await set(target, entry.at);
    else await remove(target);
    // Only clear if it hasn't been re-tapped while the write was in flight.
    if (pending[day] === entry) {
      delete pending[day];
      savePending();
    }
  }

  let flushing = false;
  async function flush() {
    if (flushing) return;
    flushing = true;
    try {
      for (const day of Object.keys(pending)) {
        try {
          await push(day);
        } catch (err) {
          console.warn(`Could not sync day ${day}:`, err);
          break; // still offline; leave the rest queued
        }
      }
    } finally {
      flushing = false;
      reportStatus();
    }
  }

  // Anything left over from a previous session goes out now.
  if (Object.keys(pending).length) flush();

  return {
    setDay(day, on) {
      pending[day] = { on, at: Date.now() };
      savePending();
      emit();
      reportStatus();
      flush();
    },
    clearAll() {
      const current = merge(remote, pending);
      for (const day of Object.keys(current)) pending[day] = { on: false, at: Date.now() };
      savePending();
      emit();
      reportStatus();
      flush();
    },
    destroy() {
      if (typeof unsubDays === "function") unsubDays();
      else off(daysRef);
      if (typeof unsubConn === "function") unsubConn();
      else off(connRef);
    },
  };
}

/* -------------------------------------------------------------------------
   Entry point
   ------------------------------------------------------------------------- */

export async function createSync({ config, roomId, onState, onStatus }) {
  if (!isConfigured(config)) {
    return createLocalSync({ roomId, onState, onStatus, reason: "unconfigured" });
  }
  try {
    return await createFirebaseSync({ config, roomId, onState, onStatus });
  } catch (err) {
    console.error("Firebase sync unavailable, falling back to this device only:", err);
    return createLocalSync({ roomId, onState, onStatus, reason: "error" });
  }
}
