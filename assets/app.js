import { FIREBASE_CONFIG, CHALLENGE, ROOM_ID } from "./config.js";
import { createSync, isConfigured } from "./sync.js";

/* -------------------------------------------------------------------------
   Challenge maths and dates
   ------------------------------------------------------------------------- */

const DAYS = CHALLENGE.days;
const GOAL = (DAYS * (DAYS + 1)) / 2;

const money = new Intl.NumberFormat(CHALLENGE.locale, {
  style: "currency",
  currency: CHALLENGE.currency,
  maximumFractionDigits: 0,
});

const shortDate = new Intl.DateTimeFormat(CHALLENGE.locale, { month: "short", day: "numeric" });
const longDate = new Intl.DateTimeFormat(CHALLENGE.locale, {
  weekday: "short",
  month: "short",
  day: "numeric",
  year: "numeric",
});

/** Parse YYYY-MM-DD as a local date. `new Date("2026-08-13")` would be UTC
 *  midnight, which reads as the 12th in every US timezone. */
function localDate(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d);
}

function toISO(date) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Round-tripping through Date catches the shapes a regex can't, like
 *  2026-02-31, which rolls forward to March rather than failing. */
function isValidISO(iso) {
  if (typeof iso !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return false;
  const parsed = localDate(iso);
  return !Number.isNaN(parsed.getTime()) && toISO(parsed) === iso;
}

/** The start date belongs to the room — CHALLENGE.startDate is only the seed
 *  used until the room reports one of its own. */
let startISO = isValidISO(CHALLENGE.startDate) ? CHALLENGE.startDate : toISO(new Date());
let START = localDate(startISO);

function dateFor(day) {
  const d = new Date(START.getTime());
  d.setDate(d.getDate() + (day - 1));
  return d;
}

function sameDay(a, b) {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/** Which challenge day is today, or 0 if we're outside the window. */
function currentDay() {
  const now = new Date();
  for (let i = 1; i <= DAYS; i++) if (sameDay(dateFor(i), now)) return i;
  return 0;
}

/* -------------------------------------------------------------------------
   Room identity
   ------------------------------------------------------------------------- */

const ROOM_STORE = "savings100:room";

function randomRoom() {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(36).padStart(2, "0")).join("").slice(0, 18);
}

/** Precedence: share link, then a pinned config room, then whatever this
 *  device used last, then a fresh one. */
function resolveRoom() {
  const fromHash = new URLSearchParams(location.hash.slice(1)).get("r");
  if (fromHash) {
    localStorage.setItem(ROOM_STORE, fromHash);
    return fromHash;
  }
  if (ROOM_ID) return ROOM_ID;

  const stored = localStorage.getItem(ROOM_STORE);
  if (stored) return stored;

  const fresh = randomRoom();
  localStorage.setItem(ROOM_STORE, fresh);
  return fresh;
}

const room = resolveRoom();

function shareUrl() {
  return `${location.origin}${location.pathname}#r=${encodeURIComponent(room)}`;
}

/* -------------------------------------------------------------------------
   Elements
   ------------------------------------------------------------------------- */

const el = (id) => document.getElementById(id);

const grid = el("grid");
const railbar = el("railbar");
const toastEl = el("toast");
const statusChip = el("status");
const resetBtn = el("reset");

/* -------------------------------------------------------------------------
   Grid
   ------------------------------------------------------------------------- */

const cells = new Map();
let state = {};
let sync = null;
let today = currentDay();

function buildGrid() {
  const frag = document.createDocumentFragment();

  for (let i = 1; i <= DAYS; i++) {
    const date = dateFor(i);
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "cell" + (i === today ? " today" : "");
    btn.style.setProperty("--w", `${(i / DAYS) * 100}%`);
    btn.setAttribute("aria-pressed", "false");
    btn.setAttribute("aria-label", `Day ${i}, ${shortDate.format(date)}, ${money.format(i)}`);
    btn.dataset.day = String(i);
    btn.innerHTML =
      `<span class="n">${i}</span>` +
      `<span class="amt">${money.format(i)}</span>` +
      `<span class="d">${shortDate.format(date)}</span>`;
    frag.appendChild(btn);
    cells.set(i, btn);
  }

  grid.appendChild(frag);
}

/** Taps made before the backend finishes connecting, replayed once it does. */
const buffered = [];

/** One listener on the grid instead of 100 on the cells. */
grid.addEventListener("click", (event) => {
  const btn = event.target.closest(".cell");
  if (!btn) return;

  const day = Number(btn.dataset.day);
  const turningOn = !state[day];

  // Paint before the write so the tap feels instant on a slow phone. The
  // backend echoes the real state back and render() reconciles.
  if (turningOn) state[day] = Date.now();
  else delete state[day];
  render();
  buzz(turningOn ? 12 : 6);
  if (turningOn) dropCoin();

  if (sync) sync.setDay(day, turningOn);
  else buffered.push([day, turningOn]);
});

/* -------------------------------------------------------------------------
   Render
   ------------------------------------------------------------------------- */

function render() {
  let sum = 0;
  let marked = 0;

  for (let i = 1; i <= DAYS; i++) {
    const on = Boolean(state[i]);
    if (on) {
      sum += i;
      marked++;
    }
    const cell = cells.get(i);
    const shown = cell.getAttribute("aria-pressed") === "true";
    if (shown !== on) cell.setAttribute("aria-pressed", on ? "true" : "false");
  }

  const pct = (sum / GOAL) * 100;

  el("total").textContent = money.format(sum);
  el("count").textContent = `${marked} / ${DAYS}`;
  el("left").textContent = money.format(GOAL - sum);
  el("fill").style.width = `${pct}%`;

  el("railTotal").textContent = money.format(sum);
  el("railCount").textContent = `${marked} / ${DAYS}`;
  el("railFill").style.width = `${pct}%`;

  let next = 0;
  for (let i = 1; i <= DAYS; i++) {
    if (!state[i]) {
      next = i;
      break;
    }
  }
  el("next").textContent = next
    ? `${money.format(next)} · ${shortDate.format(dateFor(next))}`
    : "Complete";

  resetBtn.disabled = marked === 0;
}

function renderStatic() {
  el("goalHeadline").textContent = money.format(GOAL);
  el("goalInline").textContent = money.format(GOAL);
  el("lastDayNum").textContent = String(DAYS);
  el("startLabel").textContent = longDate.format(dateFor(1));
  el("endLabel").textContent = longDate.format(dateFor(DAYS));
}

/** Repaint what the start date decides: every square's date, and which one is
 *  today. The amounts are tied to the day number, so they don't move. */
function refreshDates() {
  for (let i = 1; i <= DAYS; i++) {
    const cell = cells.get(i);
    if (!cell) continue;
    const date = dateFor(i);
    cell.querySelector(".d").textContent = shortDate.format(date);
    cell.setAttribute("aria-label", `Day ${i}, ${shortDate.format(date)}, ${money.format(i)}`);
    cell.classList.toggle("today", i === today);
  }
}

/** Returns whether anything actually moved, so an echo of our own write
 *  doesn't cause a pointless repaint of 100 cells. */
function applyStart(iso) {
  if (!isValidISO(iso) || iso === startISO) return false;

  startISO = iso;
  START = localDate(iso);
  today = currentDay();

  renderStatic();
  refreshDates();
  render();
  return true;
}

/* -------------------------------------------------------------------------
   Status chip
   ------------------------------------------------------------------------- */

const STATUS_TEXT = {
  connecting: "Connecting",
  synced: "Shared",
  syncing: "Saving",
  offline: "Offline",
  local: "This device",
  error: "Sync error",
};

let lastStatus = { mode: "local", state: "local" };

function paintStatus(status) {
  lastStatus = status;
  statusChip.dataset.state = status.state;
  statusChip.querySelector(".chip__text").textContent = STATUS_TEXT[status.state] || status.state;

  const note = el("syncNote");
  if (status.mode === "remote") {
    if (status.error) {
      note.textContent = `Sync refused at ${status.error.at}: ${status.error.code}. Tap the chip for details.`;
    } else if (status.state === "offline") {
      note.textContent = `Offline — ${status.queued || 0} change(s) queued, they'll sync when you're back.`;
    } else if (status.state === "connecting") {
      note.textContent = "Connecting to the shared ledger…";
    } else {
      note.textContent = "Shared ledger. Both devices see the same squares.";
    }
  } else if (status.reason === "error") {
    note.textContent = "Could not reach the shared ledger. Saving to this device for now.";
  } else {
    note.textContent = "Saved on this device only. Add your Firebase config to share it.";
  }
}

/* Tapping the chip is the diagnostic path — the alternative is asking someone
   to open a console on a phone. */
statusChip.addEventListener("click", () => {
  const s = lastStatus;

  if (s.mode !== "remote") {
    toast("Local only — see README.md to turn on sharing.");
    return;
  }
  if (s.error) {
    toast(`${s.error.code} on ${s.error.at}. Host ${s.host}. Check the database rules.`);
    return;
  }
  if (s.state === "connecting") {
    toast(`Opening a socket to ${s.host}…`);
    return;
  }
  if (s.state === "offline") {
    toast(`Can't reach ${s.host}. ${s.queued || 0} change(s) queued. Room ${room.slice(0, 6)}…`);
    return;
  }
  toast(`Synced. Room ${room.slice(0, 6)}…`);
});

/* -------------------------------------------------------------------------
   Actions
   ------------------------------------------------------------------------- */

/** Restarting the animation needs the class gone for a frame, not just
 *  re-added, or a fast second tap does nothing. */
const pig = el("pig");
let coinTimer;

function dropCoin() {
  if (!pig) return;
  pig.classList.remove("is-depositing");
  void pig.offsetWidth;
  pig.classList.add("is-depositing");
  clearTimeout(coinTimer);
  coinTimer = setTimeout(() => pig.classList.remove("is-depositing"), 700);
}

function buzz(ms) {
  if (navigator.vibrate) {
    try {
      navigator.vibrate(ms);
    } catch {
      /* not supported or blocked */
    }
  }
}

let toastTimer;
function toast(message) {
  toastEl.textContent = message;
  toastEl.classList.add("is-visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove("is-visible"), 2800);
}

el("share").addEventListener("click", async () => {
  const url = shareUrl();

  if (!isConfigured(FIREBASE_CONFIG)) {
    toast("Sharing needs Firebase set up first — see README.md.");
    return;
  }

  // Native share sheet on phones, clipboard everywhere else.
  if (navigator.share) {
    try {
      await navigator.share({ title: "100-Day Savings Challenge", url });
      return;
    } catch (err) {
      if (err && err.name === "AbortError") return;
    }
  }

  try {
    await navigator.clipboard.writeText(url);
    toast("Link copied. Open it on the other phone.");
  } catch {
    prompt("Copy this link:", url);
  }
});

/* Cycles preference rather than flipping appearance, so "follow the system"
   stays reachable instead of being a state you can only get back to by
   clearing storage. */
const THEME_ORDER = ["system", "light", "dark"];
const THEME_LABEL = { system: "matching your system", light: "light", dark: "dark" };

el("theme").addEventListener("click", () => {
  const theme = window.__theme;
  if (!theme) return;
  const next = THEME_ORDER[(THEME_ORDER.indexOf(theme.pref()) + 1) % THEME_ORDER.length];
  theme.set(next);
  toast(`Theme: ${THEME_LABEL[next]}.`);
  buzz(8);
});

/* ---------- start date -------------------------------------------------- */

const startDialog = el("startDialog");
const startInput = el("startInput");
const startError = el("startError");
const startSave = el("startSave");

function showStartError(message) {
  startError.textContent = message;
  startError.hidden = false;
}

el("editStart").addEventListener("click", () => {
  startInput.value = startISO;
  startError.hidden = true;
  startSave.disabled = false;
  startDialog.showModal();
});

el("startCancel").addEventListener("click", () => startDialog.close());

el("startForm").addEventListener("submit", async (event) => {
  event.preventDefault();

  const iso = startInput.value;
  if (!isValidISO(iso)) {
    showStartError("That isn't a date the challenge can start on.");
    return;
  }
  if (iso === startISO) {
    startDialog.close();
    return;
  }

  startSave.disabled = true;
  try {
    // The write echoes back through onMeta, which is what repaints the grid.
    // Without a backend yet, apply it directly so the dialog still works.
    if (sync) await sync.setStartDate(iso);
    else applyStart(iso);

    startDialog.close();
    toast(`Day 1 is now ${longDate.format(localDate(iso))}.`);
    buzz(10);
  } catch (err) {
    showStartError(err.message);
  } finally {
    startSave.disabled = false;
  }
});

el("today").addEventListener("click", () => {
  if (!today) {
    const now = new Date();
    toast(now < START ? "The challenge hasn't started yet." : "The challenge window has ended.");
    return;
  }
  const cell = cells.get(today);
  cell.scrollIntoView({ behavior: "smooth", block: "center" });
  cell.classList.remove("is-flash");
  void cell.offsetWidth; // restart the animation
  cell.classList.add("is-flash");
  buzz(10);
});

/* Clearing wipes the ledger for both of you, so it takes two taps. */
let armed = false;
let armTimer;

function disarm() {
  armed = false;
  clearTimeout(armTimer);
  resetBtn.classList.remove("is-armed");
  resetBtn.querySelector("span").textContent = "Clear";
}

resetBtn.addEventListener("click", () => {
  if (!armed) {
    armed = true;
    resetBtn.classList.add("is-armed");
    resetBtn.querySelector("span").textContent = "Sure?";
    buzz(15);
    armTimer = setTimeout(disarm, 4000);
    return;
  }
  disarm();
  sync?.clearAll();
  buzz([10, 40, 10]);
  toast("Cleared.");
});

/* -------------------------------------------------------------------------
   Condensed rail
   ------------------------------------------------------------------------- */

function watchRail() {
  const sentinel = el("sentinel");
  if (!("IntersectionObserver" in window)) return;

  new IntersectionObserver(
    ([entry]) => railbar.classList.toggle("is-visible", !entry.isIntersecting),
    { threshold: 0 }
  ).observe(sentinel);
}

/* -------------------------------------------------------------------------
   Boot
   ------------------------------------------------------------------------- */

renderStatic();
buildGrid();
render();
watchRail();

createSync({
  config: FIREBASE_CONFIG,
  roomId: room,
  onState(next) {
    state = next;
    render();
  },
  onStatus: paintStatus,
  onMeta(meta) {
    if (meta && meta.startDate) applyStart(meta.startDate);
  },
}).then((instance) => {
  sync = instance;
  for (const [day, on] of buffered.splice(0)) sync.setDay(day, on);

  // Land on today on first paint, so a phone opens where you actually are.
  if (today) {
    requestAnimationFrame(() =>
      cells.get(today).scrollIntoView({ block: "center", behavior: "auto" })
    );
  }
});

// A share link opened in an already-running tab should switch rooms.
window.addEventListener("hashchange", () => {
  const next = new URLSearchParams(location.hash.slice(1)).get("r");
  if (next && next !== room) location.reload();
});

if ("serviceWorker" in navigator && location.protocol === "https:") {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").catch(() => {
      /* offline support is a bonus, not a requirement */
    });
  });
}
