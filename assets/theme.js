/**
 * Theme resolution.
 *
 * Loaded synchronously from <head>, before the stylesheet paints, so the page
 * never flashes the wrong palette on the way in. That also rules out an inline
 * script: the deploy CSP is `script-src 'self'` with no unsafe-inline, so this
 * has to be a real file.
 *
 * Two attributes end up on <html>:
 *   data-theme-pref   what the user chose      — "system" | "light" | "dark"
 *   data-theme        what that resolves to    — "light" | "dark"
 *
 * The stylesheet only ever reads data-theme, so it needs one palette override
 * rather than a media query and a selector that have to be kept in step.
 */
(function () {
  var KEY = "savings100:theme";
  var root = document.documentElement;
  var media = window.matchMedia("(prefers-color-scheme: light)");

  /* Keep these in step with --ink in app.css; it is what paints the phone's
     status bar and the browser chrome around the page. */
  var BAR = { light: "#fff6ec", dark: "#1a1024" };

  function readPref() {
    try {
      var stored = localStorage.getItem(KEY);
      if (stored === "light" || stored === "dark" || stored === "system") return stored;
    } catch (err) {
      /* private mode: fall through to the system default */
    }
    return "system";
  }

  function resolve(pref) {
    if (pref === "light" || pref === "dark") return pref;
    return media.matches ? "light" : "dark";
  }

  function apply(pref) {
    var resolved = resolve(pref);
    root.setAttribute("data-theme-pref", pref);
    root.setAttribute("data-theme", resolved);

    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute("content", BAR[resolved]);

    return resolved;
  }

  apply(readPref());

  // Following the system theme means following it as it changes.
  var onSystemChange = function () {
    if (readPref() === "system") apply("system");
  };
  if (media.addEventListener) media.addEventListener("change", onSystemChange);
  else if (media.addListener) media.addListener(onSystemChange);

  window.__theme = {
    pref: readPref,
    resolved: function () {
      return resolve(readPref());
    },
    set: function (pref) {
      try {
        localStorage.setItem(KEY, pref);
      } catch (err) {
        /* not persisted, but still applied for this session */
      }
      return apply(pref);
    },
  };
})();
