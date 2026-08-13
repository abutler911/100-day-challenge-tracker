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

/**
 * How many days the calendar says have passed, 1 on the start date. Unlike
 * currentDay this keeps counting outside the window — 0 or negative before
 * the start, above DAYS after the end — because "how far behind am I" still
 * has an answer once the hundred days are up.
 *
 * Both dates are flattened to midnight so a clock-time difference can't round
 * a day across a daylight-saving boundary.
 */
function elapsedDay() {
  const now = new Date();
  const a = new Date(START.getFullYear(), START.getMonth(), START.getDate());
  const b = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((b - a) / 86400000) + 1;
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
const paceEl = el("pace");

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
    // Sweeps in rather than appearing all at once. Capped so the hundredth
    // square is not still waiting half a second after the first.
    btn.style.setProperty("--in-delay", `${Math.min(i * 7, 520)}ms`);
    btn.innerHTML =
      `<span class="n">${i}</span>` +
      `<span class="amt">${money.format(i)}</span>` +
      `<span class="d">${shortDate.format(date)}</span>`;
    frag.appendChild(btn);
    cells.set(i, btn);
  }

  grid.appendChild(frag);

  // Only ever on the first paint — dropped once it has played so later
  // re-renders don't replay it.
  if (!reduceMotion.matches) {
    grid.classList.add("is-entering");
    setTimeout(() => grid.classList.remove("is-entering"), 1100);
  }
}

function popCell(cell) {
  if (reduceMotion.matches) return;
  cell.classList.remove("is-popping");
  void cell.offsetWidth;
  cell.classList.add("is-popping");
  setTimeout(() => cell.classList.remove("is-popping"), 460);
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
  const marked = render();

  if (turningOn) {
    popCell(btn);
    dropCoin();
    // Every tenth square earns a burst. celebrate() does its own haptic, so
    // the plain one would only muddy it.
    if (marked > 0 && marked % 10 === 0) celebrate(marked);
    else buzz(12);
  } else {
    buzz(6);
  }

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

  countTo(sum);
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

  paintPace(marked);

  resetBtn.disabled = marked === 0;
  return marked;
}

/* -------------------------------------------------------------------------
   The running total
   ------------------------------------------------------------------------- */

const totalEl = el("total");
const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

/* What is on screen right now, and where it is heading. These have to be
   separate: a tap makes the backend echo the same state straight back, so
   countTo is called twice with the same target within a frame. Tracking only
   the destination made the second call believe it had already arrived, cancel
   the animation and snap. */
let displayTotal = 0;
let targetTotal = 0;
let countFrame = 0;
let counting = false;

/**
 * Rolls the figure to its new value instead of swapping it. One rAF loop, no
 * library. A repeat call for the same destination is ignored so the echo
 * cannot interrupt the roll; a genuinely new destination retargets from
 * wherever the digits currently are, so fast taps chain rather than jump.
 *
 * The first paint and anyone who has asked for less motion get the number
 * directly — an animated count on load is a stunt, not feedback.
 */
function countTo(next) {
  if (counting && next === targetTotal) return;

  cancelAnimationFrame(countFrame);
  targetTotal = next;

  if (reduceMotion.matches || displayTotal === next) {
    counting = false;
    displayTotal = next;
    totalEl.textContent = money.format(next);
    return;
  }

  const from = displayTotal;
  const delta = next - from;
  const started = performance.now();
  // Long enough to read as motion, scaled a little by how far it has to go.
  const dur = Math.min(900, 260 + Math.abs(delta) * 6);
  counting = true;

  const step = (now) => {
    const t = Math.min(1, (now - started) / dur);
    // easeOutCubic: quick off the mark, settles gently.
    const eased = 1 - Math.pow(1 - t, 3);
    displayTotal = Math.round(from + delta * eased);
    totalEl.textContent = money.format(displayTotal);

    if (t < 1) {
      countFrame = requestAnimationFrame(step);
    } else {
      counting = false;
      displayTotal = next;
      totalEl.textContent = money.format(next);
    }
  };
  countFrame = requestAnimationFrame(step);

  totalEl.classList.remove("is-bumped");
  void totalEl.offsetWidth;
  totalEl.classList.add("is-bumped");
}

/* -------------------------------------------------------------------------
   Celebration
   ------------------------------------------------------------------------- */

const CHEERS = [
  "Nice.", "Ten more.", "Rolling.", "Look at you.", "Halfway!",
  "Unstoppable.", "So close.", "Nearly there.", "One to go.", "DONE!",
];

/**
 * Fires on every tenth square. Spans rather than a canvas: nothing runs when
 * idle, there is no library, and the whole node removes itself on the way out.
 */
function celebrate(marked) {
  if (reduceMotion.matches) return;

  const palette = ["--coral", "--tangerine", "--sunny", "--mint", "--grape", "--sky"];
  const layer = document.createElement("div");
  layer.className = "confetti";

  for (let i = 0; i < 46; i++) {
    const bit = document.createElement("i");
    const angle = Math.random() * Math.PI * 2;
    const reach = 120 + Math.random() * 260;
    bit.style.cssText = `
      --x:${45 + Math.random() * 10}vw; --y:${34 + Math.random() * 8}vh;
      --dx:${Math.cos(angle) * reach}px; --dy:${Math.sin(angle) * reach + 220}px;
      --size:${6 + Math.random() * 8}px;
      --c:var(${palette[i % palette.length]});
      --round:${Math.random() > 0.5 ? "50%" : "2px"};
      --spin:${Math.random() * 900 - 450}deg;
      --dur:${1100 + Math.random() * 700}ms;
      --delay:${Math.random() * 180}ms;
    `;
    layer.appendChild(bit);
  }

  const banner = document.createElement("div");
  banner.className = "cheer";
  banner.textContent = CHEERS[Math.min(CHEERS.length - 1, Math.floor(marked / 10) - 1)] || "Nice.";

  document.body.append(layer, banner);
  setTimeout(() => {
    layer.remove();
    banner.remove();
  }, 2100);

  buzz([14, 60, 14]);
}

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

/**
 * Says how far along you are against how far along the date says you should
 * be, counted in squares retired rather than dollars banked.
 *
 * The count is what decides whether the challenge finishes on time: it ends
 * when all hundred are ticked, in whatever order they were ticked. Amount
 * answers a different question — clearing 100, 99 and 98 first is $297, which
 * by money looks weeks ahead and is three days of actual progress.
 *
 * Ticking N squares means you are through day N, so N is the day you are on
 * and the calendar's day is what it is compared against.
 */
function paintPace(marked) {
  const elapsed = elapsedDay();

  let state = "even";
  let verdict;
  let detail;

  if (elapsed < 1) {
    // Getting a head start before day one is not a pace to be ahead of.
    state = "waiting";
    verdict = `Starts in ${plural(1 - elapsed, "day")}`;
    detail = marked
      ? `${plural(marked, "square")} already checked`
      : `Day 1 is ${longDate.format(dateFor(1))}`;
  } else {
    // Past the end the calendar stops at 100 — you cannot fall further behind
    // a challenge that has run out of days.
    const calendar = Math.min(elapsed, DAYS);
    const delta = marked - calendar;

    if (marked >= DAYS) {
      state = "done";
      verdict = "All done";
      detail = `Every one of the ${DAYS} days checked off`;
    } else {
      if (delta > 0) {
        state = "ahead";
        verdict = `${plural(delta, "day")} ahead`;
      } else if (delta === 0) {
        state = "even";
        verdict = "On pace";
      } else {
        state = -delta >= 7 ? "far-behind" : "behind";
        verdict = `${plural(-delta, "day")} behind`;
      }

      detail = marked
        ? `Day ${calendar} today · you're on day ${marked}, ${shortDate.format(dateFor(marked))}`
        : `Day ${calendar} today · nothing checked yet`;
    }
  }

  paceEl.dataset.state = state;
  el("paceVerdict").textContent = verdict;
  el("paceDetail").textContent = detail;
}

function renderStatic() {
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

/* The chip is the whole status surface now — the standing explanation under
   the action bar is gone. Nothing diagnostic went with it: tapping the chip
   still reports the host, the queue and the last error. */
function paintStatus(status) {
  lastStatus = status;
  statusChip.dataset.state = status.state;
  statusChip.querySelector(".chip__text").textContent = STATUS_TEXT[status.state] || status.state;
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
      await navigator.share({ title: "100 Days to Less Broke", url });
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

/**
 * Open at the top, every time.
 *
 * Two separate things used to prevent that. The app scrolled itself to today's
 * square on first paint, and the browser restores the previous scroll offset
 * on a reload or when an installed app is resumed — which lands you partway
 * down a hundred-square grid with the headline and the total off screen. The
 * auto-scroll is gone and restoration is turned off; `Today` is still one tap
 * away when you do want to jump.
 */
if ("scrollRestoration" in history) history.scrollRestoration = "manual";

function toTop() {
  window.scrollTo(0, 0);
}

toTop();
// Layout settles after the grid is built and the fonts swap in, and a restore
// can land after this script runs, so claim the top again on the way out.
window.addEventListener("load", () => requestAnimationFrame(toTop));

renderStatic();
buildGrid();
render();
watchRail();

requestAnimationFrame(toTop);

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
