/**
 * Your settings live here. This is the only file you need to edit.
 *
 * Until FIREBASE_CONFIG is filled in, the tracker runs in local-only mode:
 * it still works, but progress stays on whichever device made it.
 * See README.md for the five-minute Firebase setup.
 */

/**
 * Paste the config object from your Firebase project here.
 * Firebase console -> Project settings -> Your apps -> Web app -> SDK setup.
 *
 * These values are NOT secrets. Firebase web config is public by design and
 * ships in every Firebase site's source. Access is controlled by the database
 * rules in database.rules.json, plus the fact that your room ID is unguessable.
 */
export const FIREBASE_CONFIG = {
  apiKey: "AIzaSyAIn-nT7ycuzGlHY6_TTmPqmL_6Y3gtDL8",
  authDomain: "day-savings-challenge-fb430.firebaseapp.com",
  databaseURL: "https://day-savings-challenge-fb430-default-rtdb.firebaseio.com",
  projectId: "day-savings-challenge-fb430",
};

/** The challenge itself. */
export const CHALLENGE = {
  /**
   * Day 1, as YYYY-MM-DD. Read as a local date, not UTC.
   *
   * Only the seed. Once a start date is set from the app it lives in the room
   * and applies to both devices, and this value is just what a brand new room
   * begins with.
   */
  startDate: "2026-08-13",
  /** Day count. Day N costs $N, so 100 days totals $5,050. */
  days: 100,
  locale: "en-US",
  currency: "USD",
};

/**
 * Leave this empty. The app then generates a random room on first open, and
 * the Share button sends the link to the other device — a one-time step, since
 * the room is remembered locally afterwards.
 *
 * You can instead pin a fixed room here so every device lands in the same
 * ledger with no link to pass around. Only do that in a PRIVATE repository.
 * Nothing but the room ID's unguessability keeps this ledger private, so
 * committing one to a public repo publishes the only thing standing between
 * a stranger and your data — they could read it, or write to it.
 *
 * If you want pinning, make the repo private first, or keep the value out of
 * git and inject it at deploy time.
 */
export const ROOM_ID = "";
