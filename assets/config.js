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
  apiKey: "",
  authDomain: "",
  databaseURL: "",
  projectId: "",
};

/** The challenge itself. */
export const CHALLENGE = {
  /** Day 1, as YYYY-MM-DD. Read as a local date, not UTC. */
  startDate: "2026-08-13",
  /** Day count. Day N costs $N, so 100 days totals $5,050. */
  days: 100,
  locale: "en-US",
  currency: "USD",
};

/**
 * Optional. Pin a fixed room so both phones always land in the same ledger
 * without needing the share link, e.g. "our-house-fund-2026".
 *
 * Leave it empty and the app generates a random room on first open; use the
 * Share button to send the link to the other device. Either way works.
 */
export const ROOM_ID = "";
