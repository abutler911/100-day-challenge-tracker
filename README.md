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

1. Go to <https://console.firebase.google.com> and **Add project**. Name it
   anything. Google Analytics is not needed — turn it off.

2. **Build → Realtime Database → Create Database.** Pick the region closest to
   you and choose **Start in locked mode**. (The rules below replace the
   defaults in step 4.)

3. **Build → Authentication → Get started → Sign-in method → Anonymous →
   Enable.** This is what lets both phones read the same ledger without either
   of you making an account.

4. Back in **Realtime Database → Rules**, replace everything with the contents
   of [`database.rules.json`](database.rules.json) and hit **Publish**.

5. **Project settings (gear icon) → Your apps → Web (`</>`)**. Register the app
   with any nickname. Firebase shows you a `firebaseConfig` object — copy the
   four values into `assets/config.js`:

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

If you'd rather not deal with links, pin a room in `assets/config.js`:

```js
export const ROOM_ID = "our-house-fund-2026";
```

Every device that loads the site lands in that room. Pick something nobody
would guess — it is effectively the password.

---

## 3. Change the dates or the length

`assets/config.js`:

```js
export const CHALLENGE = {
  startDate: "2026-08-13",  // day 1, local time
  days: 100,                // day N costs $N
  locale: "en-US",
  currency: "USD",
};
```

The goal recalculates itself: `days × (days + 1) ÷ 2`.

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
