# 100-Day Savings Challenge

A dollar a day, plus one, until it's $5,050. Day 1 costs $1, day 100 costs $100.

Two people, one shared ledger. Tap a square on either phone and it turns
crimson on both.

```
index.html              markup
assets/app.css          all styling, mobile-first
assets/app.js           grid, rendering, actions
assets/sync.js          Firebase / localStorage sync
assets/config.js        the only file you need to edit
database.rules.json     Firebase security rules
sw.js                   offline shell
```

No build step, no dependencies to install. It's a static site.

---

## 1. Turn on sharing (about five minutes)

Without this the tracker still works, but progress stays on whichever device
made it. The status chip in the top right will read **This device**.

Google reorganizes the Firebase console's navigation periodically, so the
sidebar you see may not match the one described here. The **Search for
products** box at the top of the sidebar is the stable way in — searching for
"Realtime Database" or "Authentication" lands you in the right place whatever
the current layout calls its sections. The free **Spark** plan covers this
comfortably; the tracker stores 100 numbers.

1. Go to <https://console.firebase.google.com> and **Add project**. Name it
   anything. Google Analytics is not needed — turn it off.

2. Open **Realtime Database** (currently under *Databases & Storage*; older
   consoles filed it under *Build*) and **Create Database**. Pick the region
   closest to you and choose **Start in locked mode** — the rules in step 4
   replace the defaults.

   Take the *Realtime* part literally. The console promotes **Firestore** more
   prominently, and it is a different product — `assets/sync.js` talks to
   Realtime Database and will not work against Firestore.

   Note which region you picked. US-central projects get a `firebaseio.com`
   database URL; every other region gets `firebasedatabase.app`. Both are
   allowed by the deploy configs' CSP, so either is fine — just don't retype
   the URL by hand later.

3. Open **Authentication** (currently under *Security*) → **Get started** →
   **Sign-in method** → **Anonymous** → **Enable**. This is what lets both
   phones read the same ledger without either of you making an account.

   Don't skip this one. The rules require an authenticated user, so without it
   every read and write is denied, and the app falls back to local-only with a
   **This device** chip rather than showing an error. If everything else looks
   right and sharing still isn't working, check here first.

4. Back in **Realtime Database → Rules**, replace everything with the contents
   of [`database.rules.json`](database.rules.json) and hit **Publish**.

5. **Project settings (gear icon next to Project Overview) → Your apps →
   Web (`</>`)**. Register the app with any nickname. Firebase shows you a
   `firebaseConfig` object — copy the four values into `assets/config.js`:

   ```js
   export const FIREBASE_CONFIG = {
     apiKey: "AIza…",
     authDomain: "your-project.firebaseapp.com",
     databaseURL: "https://your-project-default-rtdb.firebaseio.com",
     projectId: "your-project",
   };
   ```

   If `databaseURL` isn't in the snippet, copy it from the Realtime Database
   page — it's the URL at the top.

6. Commit and deploy. The chip should now read **Shared**.

### Is it safe to commit those keys?

Yes. A Firebase web config is public by design — it ships in the source of
every Firebase-backed site. It identifies the project; it doesn't authorize
anything on its own. Access is governed by `database.rules.json`.

Read the trade-off honestly, though: those rules allow **any** anonymous user
to read and write **a room they can name**. What actually keeps your ledger
private is that the room ID is a random 18-character string nobody can guess —
the same model as an unlisted share link. For a savings tracker between two
people that's a sensible place to land. If you want it locked down harder, see
[Tighter access](#tighter-access) below.

---

## 2. Get it on both phones

Deploy to **Netlify** or **Vercel** — `netlify.toml` and `vercel.json` are both
here, and neither needs a build command.

**Netlify:** Add new site → Import an existing project → pick this repo →
Deploy. Publish directory `.`, build command empty.

**Vercel:** Add New → Project → import this repo → Framework preset **Other** →
Deploy.

Then:

1. Open the deployed URL on your phone.
2. Tap **Share**. On a phone this opens the native share sheet; on a desktop it
   copies the link.
3. Send it to your wife. Opening that link puts her device in the same room.
4. Both of you: **Add to Home Screen** (iOS: Share → Add to Home Screen;
   Android: menu → Install app). It installs as a standalone app with its own
   icon, no browser chrome.

### Skipping the share link

If you'd rather not deal with links, you can pin a room in `assets/config.js`
so every device that loads the site lands in the same ledger:

```js
export const ROOM_ID = "a-long-string-nobody-would-guess";
```

**Only do this in a private repository.** The room ID is effectively the
password — it is the one thing keeping the ledger private — so committing it
to a public repo publishes it. Anyone who found the repo could read the ID,
authenticate anonymously, and read or write your data.

In a public repo, leave `ROOM_ID` empty and use the share link. The generated
room never touches git: it lives in the URL you send and in each device's
local storage. If you want pinning anyway, make the repo private, or keep the
value out of git and inject it at deploy time.

---

## 3. Change the dates or the length

### The start date, from the app

Tap the Day 1 date under the headline. Pick a new one and every square
relabels; the amounts don't move, because they follow the day number rather
than the calendar. The `Today` highlight lands wherever today falls in the new
window, or nowhere if the challenge hasn't started.

This setting belongs to the room, not the phone — otherwise the two of you
would see different dates on the same squares — so changing it changes it for
both of you.

> **Upgrading an existing setup?** The start date lives under a `meta` node the
> original rules didn't allow. Re-publish [`database.rules.json`](database.rules.json)
> in the Firebase console (Realtime Database → Rules → Publish) or saving a date
> fails with a permission error. The app says so plainly if you forget.

### Everything else, from the config

`assets/config.js`:

```js
export const CHALLENGE = {
  startDate: "2026-08-13",  // only the seed — the room's own date wins
  days: 100,                // day N costs $N
  locale: "en-US",
  currency: "USD",
};
```

The goal recalculates itself: `days × (days + 1) ÷ 2`.

## 4. Light and dark

The circle button next to the status chip cycles **match the system → light →
dark**, and remembers the choice on that device. It defaults to following the
system, so it flips with the phone's own light/dark schedule.

The theme is a per-device preference rather than a room setting: it changes
nothing about the ledger, so there's no reason for one of you to be stuck with
the other's choice.

---

## How the sync behaves

- **Live.** Writes land through Firebase's socket; the other phone updates in
  under a second with no refresh.
- **Optimistic.** A tap paints immediately, then syncs. You never wait on the
  network.
- **Offline-tolerant.** Every tap is queued in `localStorage` *before* the
  network is touched, so a change made in a dead zone survives closing the app
  and replays on reconnect. The chip reads **Offline** with a queued count.
- **Conflicts.** Last write wins, per day. Two people toggling the same square
  in the same second is the only way to notice, and the loser is one tap.
- **Cold start.** The last server snapshot is cached, so opening the app shows
  real numbers instantly instead of zeros while the socket connects.
- **What the chip means.** **Connecting** while the socket is still opening,
  **Shared** once it's up, **Offline** only after a connection actually
  dropped — or after eight seconds of never reaching one. "Not connected yet"
  and "connection lost" look identical to the database client, and conflating
  them is why a healthy cold start used to flash Offline.

If Firebase is unreachable at load, the app falls back to device-local storage
rather than showing an error, and says so in the footer.

---

## Tighter access

To restrict the ledger to two specific accounts, switch Authentication to
Email/Password, create both accounts, and replace the room rules with a UID
allowlist:

```json
{
  "rules": {
    "rooms": {
      "$room": {
        ".read": "auth != null && (auth.uid === 'UID_ONE' || auth.uid === 'UID_TWO')",
        ".write": "auth != null && (auth.uid === 'UID_ONE' || auth.uid === 'UID_TWO')"
      }
    }
  }
}
```

That also means adding a sign-in screen, which this build doesn't have.

---

## Running it locally

ES modules need a real server — opening `index.html` from the filesystem won't
work.

```sh
python3 -m http.server 8000
# then open http://localhost:8000
```

The service worker only registers over HTTPS, so it stays out of the way in
local development.
