/**
 * Sync layer.
 *
 * Two interchangeable backends behind one interface:
 *
 *   createSync({ config, roomId, onState, onStatus, onMeta, onMessages })
 *     -> { setDay(day, on), clearAll(), setStartDate(iso), sendMessage(entry),
 *          destroy() }
 *
 *   - Firebase Realtime Database when config is filled in. Shared across
 *     devices, live, no refresh needed.
 *   - localStorage otherwise, so an unconfigured deploy still works (and
 *     still syncs across tabs on the same device).
 *
 * State is a plain object of marked days: { "1": 1755057600000, "7": ... }
 * where the value is the timestamp it was marked. Absent means unmarked.
 *
 * Room settings that both devices must agree on — currently just the start
 * date — live alongside it under `meta` and arrive through onMeta.
 *
 * Notes the two of you leave each other live under `messages`, keyed by a
 * push id so they order themselves, and arrive through onMessages as an array
 * sorted oldest first. Only the last MESSAGE_LIMIT are ever read or kept.
 *
 * Writes are optimistic. Each one goes into a pending queue that is persisted
 * to localStorage before the network is touched, so a write made in a dead
 * zone survives a reload and replays on reconnect. Notes get their own queue
 * with the same guarantee — a note typed in a lift is not lost, it is sent
 * when there is signal again.
 */

const FIREBASE_VERSION = "12.17.1";
const cdn = (mod) => `https://www.gstatic.com/firebasejs/${FIREBASE_VERSION}/firebase-${mod}.js`;

const cacheKey = (room) => `savings100:cache:${room}`;
const pendingKey = (room) => `savings100:pending:${room}`;
const metaKey = (room) => `savings100:meta:${room}`;
const messagesKey = (room) => `savings100:messages:${room}`;
const outboxKey = (room) => `savings100:outbox:${room}`;

/** How many notes are read, kept and shown. A board between two people is not
 *  an archive, and an unbounded one would grow the payload of every cold start
 *  forever. */
export const MESSAGE_LIMIT = 100;

/** Matched by the database rules. Anything longer is refused there, so the
 *  composer has to agree or the write fails after the fact. */
export const MESSAGE_MAX = 500;

export function isConfigured(config) {
  return Boolean(config && config.apiKey && config.databaseURL && config.projectId);
}

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return "invalid-database-url";
  }
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
 * Notes are stored keyed by id and read as a list. Sorting by timestamp with
 * the id as the tie-break keeps two notes written in the same millisecond in
 * a stable order rather than swapping places on every render.
 */
function sortMessages(map) {
  return Object.entries(map || {})
    .map(([id, m]) => ({
      id,
      at: Number(m && m.at) || 0,
      by: String((m && m.by) || ""),
      text: String((m && m.text) || ""),
      pending: Boolean(m && m.pending),
    }))
    .sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .slice(-MESSAGE_LIMIT);
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

function createLocalSync({ roomId, onState, onStatus, onMeta, onMessages, reason }) {
  const key = cacheKey(roomId);
  const mKey = metaKey(roomId);
  const msgKey = messagesKey(roomId);
  let state = readJSON(key, {});
  let meta = readJSON(mKey, {});
  let messages = readJSON(msgKey, {});

  const emit = () => onState({ ...state });
  const emitMeta = () => onMeta({ ...meta });
  const emitMessages = () => onMessages(sortMessages(messages));

  const onStorage = (event) => {
    if (event.key === key) {
      state = readJSON(key, {});
      emit();
    } else if (event.key === mKey) {
      meta = readJSON(mKey, {});
      emitMeta();
    } else if (event.key === msgKey) {
      messages = readJSON(msgKey, {});
      emitMessages();
    }
  };
  window.addEventListener("storage", onStorage);

  onStatus({ mode: "local", state: "local", reason });
  queueMicrotask(() => {
    emit();
    emitMeta();
    emitMessages();
  });

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
    async setStartDate(iso) {
      meta = { ...meta, startDate: iso };
      writeJSON(mKey, meta);
      emitMeta();
    },
    /**
     * No server to mint an id, so time plus a little randomness does the job.
     * The prefix keeps these apart from the push ids the remote backend makes,
     * which matters if a room is later carried across to a configured deploy.
     */
    async sendMessage(entry) {
      const id = `local-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      const kept = sortMessages({ ...messages, [id]: entry });
      messages = Object.fromEntries(
        kept.map(({ id: mid, at, by, text }) => [mid, { at, by, text }])
      );
      writeJSON(msgKey, messages);
      emitMessages();
    },
    destroy() {
      window.removeEventListener("storage", onStorage);
    },
  };
}

/* -------------------------------------------------------------------------
   Firebase Realtime Database backend
   ------------------------------------------------------------------------- */

async function createFirebaseSync({ config, roomId, onState, onStatus, onMeta, onMessages }) {
  onStatus({ mode: "remote", state: "connecting" });

  const [{ initializeApp }, { getAuth, signInAnonymously }, database] = await Promise.all([
    import(/* @vite-ignore */ cdn("app")),
    import(/* @vite-ignore */ cdn("auth")),
    import(/* @vite-ignore */ cdn("database")),
  ]);

  const { getDatabase, ref, onValue, set, remove, off, push, query, limitToLast } = database;

  const app = initializeApp(config);
  await signInAnonymously(getAuth(app));

  const db = getDatabase(app);
  const daysRef = ref(db, `rooms/${roomId}/days`);
  const metaRef = ref(db, `rooms/${roomId}/meta`);
  const messagesRef = ref(db, `rooms/${roomId}/messages`);
  const connRef = ref(db, ".info/connected");

  let meta = readJSON(metaKey(roomId), {});

  // Paint immediately from the last snapshot we saw, so a cold start on a
  // phone shows real numbers instead of zeros while the socket opens.
  let remote = readJSON(cacheKey(roomId), {});
  let pending = readJSON(pendingKey(roomId), {});
  let remoteMessages = readJSON(messagesKey(roomId), {});
  let outbox = readJSON(outboxKey(roomId), []);
  let connected = false;

  /**
   * `.info/connected` reports false the instant we subscribe, well before the
   * socket has had a chance to open. Calling that "Offline" is wrong and it is
   * what every cold start used to show. Until we have seen a real connection
   * we are *connecting*; only a drop after that is genuinely offline.
   *
   * The timer keeps the other failure mode honest: opening the app with no
   * signal at all would otherwise sit on "Connecting" forever.
   */
  let everConnected = false;
  let connectingTimedOut = false;
  const CONNECT_GRACE_MS = 8000;

  const graceTimer = setTimeout(() => {
    connectingTimedOut = true;
    if (!connected) reportStatus();
  }, CONNECT_GRACE_MS);

  const emit = () => onState(merge(remote, pending));
  const savePending = () => writeJSON(pendingKey(roomId), pending);
  const saveOutbox = () => writeJSON(outboxKey(roomId), outbox);

  /** Notes still in the outbox are shown alongside the confirmed ones, marked
   *  so the UI can say they are on their way rather than delivered. */
  function emitMessages() {
    const merged = { ...remoteMessages };
    for (const note of outbox) if (!merged[note.id]) merged[note.id] = { ...note, pending: true };
    onMessages(sortMessages(merged));
  }

  /**
   * A listener that gets cancelled — denied by the rules, most often — is
   * reported through onValue's third argument and nowhere else. Without one
   * the failure is completely silent, which leaves "Offline" as the only
   * symptom of problems that have nothing to do with connectivity.
   */
  let lastError = null;

  /**
   * A refused *write* is a separate channel from a cancelled listener: the
   * days listener clears lastError on every snapshot it receives, which would
   * wipe a write failure seconds after it happened. Keeping it apart is what
   * makes "the rules predate the messages node" stay on screen instead of
   * flickering past.
   */
  let sendError = null;

  function onCancel(what) {
    return (err) => {
      lastError = { at: what, code: err?.code || "unknown", message: err?.message || String(err) };
      console.error(`Sync listener on ${what} was cancelled:`, err);
      reportStatus();
    };
  }

  function reportStatus() {
    const queued = Object.keys(pending).length + outbox.length;
    const error = lastError || sendError;
    const base = { mode: "remote", queued, error, host: hostOf(config.databaseURL) };

    if (error) onStatus({ ...base, state: "error" });
    else if (connected) onStatus({ ...base, state: queued ? "syncing" : "synced" });
    else if (everConnected || connectingTimedOut) onStatus({ ...base, state: "offline" });
    else onStatus({ ...base, state: "connecting" });
  }

  queueMicrotask(() => {
    emit();
    onMeta({ ...meta });
    emitMessages();
  });

  const unsubDays = onValue(
    daysRef,
    (snap) => {
      lastError = null;
      remote = snap.val() || {};
      writeJSON(cacheKey(roomId), remote);
      emit();
    },
    onCancel("days")
  );

  const unsubMeta = onValue(
    metaRef,
    (snap) => {
      meta = snap.val() || {};
      writeJSON(metaKey(roomId), meta);
      onMeta({ ...meta });
    },
    onCancel("meta")
  );

  /* Only ever the tail. Two people will not read back past a hundred notes,
     and reading the lot would grow every cold start for the life of the room. */
  const unsubMessages = onValue(
    query(messagesRef, limitToLast(MESSAGE_LIMIT)),
    (snap) => {
      remoteMessages = snap.val() || {};
      writeJSON(messagesKey(roomId), remoteMessages);
      // Anything the server now echoes back is delivered; drop our copy.
      const before = outbox.length;
      outbox = outbox.filter((note) => !remoteMessages[note.id]);
      if (outbox.length !== before) saveOutbox();
      emitMessages();
    },
    onCancel("messages")
  );

  const unsubConn = onValue(connRef, (snap) => {
    const wasConnected = connected;
    connected = snap.val() === true;
    if (connected) {
      everConnected = true;
      clearTimeout(graceTimer);
    }
    reportStatus();
    if (connected && !wasConnected) {
      flush();
      flushOutbox();
    }
  });

  /** Push a single pending day; drop it from the queue once it lands. */
  async function pushDay(day) {
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
          await pushDay(day);
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

  /**
   * Notes go out one at a time, oldest first, and each keeps its id across
   * retries — the id is minted locally by push() before anything is written,
   * so replaying a queued note overwrites its own slot instead of arriving
   * twice.
   */
  let sending = false;
  async function flushOutbox() {
    if (sending) return;
    sending = true;
    try {
      for (const note of [...outbox]) {
        try {
          const { id, ...payload } = note;
          await set(ref(db, `rooms/${roomId}/messages/${id}`), payload);
          outbox = outbox.filter((queued) => queued.id !== id);
          saveOutbox();
          sendError = null;
        } catch (err) {
          console.warn("Could not send a note:", err);
          sendError = {
            at: "messages",
            code: err?.code || "unknown",
            message: err?.message || String(err),
          };
          break; // still offline, or refused; leave the rest queued
        }
      }
    } finally {
      sending = false;
      emitMessages();
      reportStatus();
    }
  }

  // Anything left over from a previous session goes out now.
  if (Object.keys(pending).length) flush();
  if (outbox.length) flushOutbox();

  /* One place to read the whole picture when something is wrong. Cheap to
     leave in: it allocates nothing until it is called. */
  window.__diag = () => ({
    host: hostOf(config.databaseURL),
    project: config.projectId,
    room: roomId,
    connected,
    everConnected,
    connectingTimedOut,
    queuedWrites: Object.keys(pending).length,
    queuedNotes: outbox.length,
    daysKnown: Object.keys(remote).length,
    notesKnown: Object.keys(remoteMessages).length,
    startDate: meta.startDate || "(none set)",
    lastError,
    sendError,
  });

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
    /**
     * The start date belongs to the room, not the device, or the two of you
     * would disagree about which square is today and what date every other
     * square carries.
     *
     * Applied locally first so the grid redraws instantly, then written. A
     * rejection here almost always means the database rules predate the `meta`
     * node, which is worth saying out loud rather than silently reverting.
     */
    async setStartDate(iso) {
      const previous = meta.startDate;
      meta = { ...meta, startDate: iso };
      writeJSON(metaKey(roomId), meta);
      onMeta({ ...meta });

      try {
        await set(ref(db, `rooms/${roomId}/meta/startDate`), iso);
      } catch (err) {
        meta = { ...meta };
        if (previous === undefined) delete meta.startDate;
        else meta.startDate = previous;
        writeJSON(metaKey(roomId), meta);
        onMeta({ ...meta });

        const denied = String(err && err.code) === "PERMISSION_DENIED";
        throw new Error(
          denied
            ? "The database rules don't allow a start date yet. Re-publish database.rules.json in the Firebase console."
            : "Could not save the start date. Check your connection and try again.",
          { cause: err }
        );
      }
    },
    /**
     * Optimistic like every other write here: the note is queued, painted at
     * once, and pushed. A refusal leaves it queued and puts the reason on the
     * status chip — which is where a room whose rules predate this feature
     * finds out, rather than watching notes vanish.
     */
    async sendMessage(entry) {
      // push() against the collection mints a key without writing anything,
      // and it does so client-side — so a note composed with no signal already
      // has its final id, and replaying it later is idempotent.
      const id = push(messagesRef).key;
      outbox = [...outbox, { id, ...entry }];
      saveOutbox();
      emitMessages();
      reportStatus();
      flushOutbox();
    },
    destroy() {
      clearTimeout(graceTimer);
      if (typeof unsubDays === "function") unsubDays();
      else off(daysRef);
      if (typeof unsubMeta === "function") unsubMeta();
      else off(metaRef);
      if (typeof unsubMessages === "function") unsubMessages();
      else off(messagesRef);
      if (typeof unsubConn === "function") unsubConn();
      else off(connRef);
    },
  };
}

/* -------------------------------------------------------------------------
   Entry point
   ------------------------------------------------------------------------- */

export async function createSync({
  config,
  roomId,
  onState,
  onStatus,
  onMeta = () => {},
  onMessages = () => {},
}) {
  if (!isConfigured(config)) {
    return createLocalSync({ roomId, onState, onStatus, onMeta, onMessages, reason: "unconfigured" });
  }
  try {
    return await createFirebaseSync({ config, roomId, onState, onStatus, onMeta, onMessages });
  } catch (err) {
    console.error("Firebase sync unavailable, falling back to this device only:", err);
    return createLocalSync({ roomId, onState, onStatus, onMeta, onMessages, reason: "error" });
  }
}
