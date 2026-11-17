// Arsten / Multiplan "Копирай диагностика" for the Connect panels (week 4, A23).
//
// Keeps the last 50 errors and warnings of this page (this frame: each panel and the shell have their own) and copies
// them as plain text, ready to paste into Teams: time, level, message, plus a header with the panel, its version and
// the Connect project id. Nothing is sent anywhere; the text only goes to the clipboard when the user presses the button.
//
// Collected: window "error" and "unhandledrejection", console.error / console.warn (the panels' guarded() helpers log
// there), and ArstenDiag.log(level, msg). Before anything is stored it is cleaned (URL-encoded @ = ? & : / decoded once
// first): e-mail addresses, bearer / JWT tokens, tokens written as JSON or "name: value", Authorization / x-api-key /
// Cookie header values, token-like query parameters, URL query strings (pre-signed upload URLs; scheme, host and path
// kept) and long key-like strings are replaced, and the
// names passed with set({redact}) (the signed-in user's display name) become "<потребител>".
//
// Wiring in a panel (minimal):
//   index.html: <script src="arsten-diag.js"></script> right after arsten-perf.js (before the other scripts, so their
//               load errors are caught), and one <button data-arsten-diag>Копирай диагностика</button> in the status /
//               footer area. A click on any [data-arsten-diag] element copies (event delegation; no app.js code needed).
//   app.js:     once the project is known: window.ArstenDiag && ArstenDiag.set({ panel, projectId, version, redact: [user],
//               lang: () => lang }). version: the panel's BUILD; version.json next to index.html (written by
//               scripts/release.mjs) wins when it can be read.
(function (root, factory) {
  const lib = factory(root);
  if (typeof module === "object" && module.exports) module.exports = lib;
  else root.ArstenDiag = lib;
})(typeof self !== "undefined" ? self : this, function (root) {
  "use strict";
  const MAX = 50, MSG_MAX = 600, CUT_MAX = 4000;
  const T = {
    bg: { label: "Копирай диагностика", copied: "Копирано ✓ – поставете в Teams", failed: "Маркирайте текста и копирайте (Ctrl+C)", title: "Arsten / Multiplan – диагностика",
      panel: "Панел", version: "версия", project: "проект", at: "Копирано", none: "Няма грешки и предупреждения в тази сесия.", last: "Последни грешки и предупреждения", page: "Адрес", close: "Затвори" },
    en: { label: "Copy diagnostics", copied: "Copied ✓ – paste into Teams", failed: "Select the text and copy (Ctrl+C)", title: "Arsten / Multiplan – diagnostics",
      panel: "Panel", version: "version", project: "project", at: "Copied", none: "No errors or warnings in this session.", last: "Last errors and warnings", page: "Page", close: "Close" },
  };
  const cfg = { panel: "", projectId: "", version: "", redact: [], lang: null };
  let entries = [];   // {t: Date, level, msg, n}

  const pad = (n) => String(n).padStart(2, "0");
  const hms = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  const ymdhm = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const langNow = () => {
    try {
      const i18n = root && root.ArstenI18n;   // the shared language setting (arsten-i18n.js) when the panel gave none
      const l = typeof cfg.lang === "function" ? cfg.lang() : cfg.lang || (i18n && typeof i18n.getLang === "function" ? i18n.getLang() : "");
      return l === "en" ? "en" : "bg";
    } catch { return "bg"; }
  };
  const L = () => T[langNow()];

  /** Text without tokens, e-mails, query strings, key-like strings and the given names. */
  function clean(text, names) {
    // cut BEFORE scrubbing (round 17 L2): only the first MSG_MAX characters are kept anyway, and a 100 KB server body must
    // not run every regex over all of it inside console.error. CUT_MAX leaves room for the decoding and the replacements.
    let s = String(text == null ? "" : text);
    if (s.length > CUT_MAX) s = s.slice(0, CUT_MAX);
    // URL-encoded "@ = ? & : /" decoded once, so encoded e-mails, query strings and URLs are cleaned too (round 15 L4)
    const DEC = { "40": "@", "3d": "=", "3f": "?", "26": "&", "3a": ":", "2f": "/" };
    s = s.replace(/%(40|3d|3f|26|3a|2f)/gi, (_, h) => DEC[h.toLowerCase()]);
    // header forms: "Cookie: a=1; b=2", "authorization: Basic …", "x-api-key: …" (also as JSON keys)
    s = s.replace(/\b((?:set-)?cookie)(["']?\s*:\s*["']?)[^"'\n]*/gi, "$1$2<…>");
    s = s.replace(/\b(proxy-authorization|authorization|x-api-key|api-key|x-auth-token)(["']?\s*[:=]\s*["']?)(?:(Basic|Bearer|Digest|Token|Negotiate)\s+)?[^\s"',;]+/gi,
      (_, k, sep, scheme) => `${k}${sep}${scheme ? scheme + " " : ""}<…>`);
    s = s.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer <token>");
    s = s.replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]+)?/g, "<token>");
    // tokens written as JSON ("access_token":"…") or "name: value"
    s = s.replace(/"((?:access_?|refresh_?|id_?)?token|code|sig|signature|password|passwd|secret|client_secret|api_?key)"\s*:\s*"[^"]*"/gi, '"$1":"<…>"');
    s = s.replace(/\b((?:access_?|refresh_?|id_?)token|password|passwd|secret|client_secret|api_?key|signature)\s*:\s*(?!<)[^\s"',;]+/gi, "$1: <…>");
    s = s.replace(/\b((?:access_?|refresh_?|id_?)?token|code|key|sig|signature|password|secret|auth)=([^&\s"']+)/gi, "$1=<…>");
    // full URLs: scheme, host and path kept; query and fragment dropped
    // The next three are linear (round 17 L2): the URL match always succeeds once started (the query is optional), and the
    // e-mail / key matches may only start where a run of their characters starts, so no run is scanned from every position.
    s = s.replace(/(https?:\/\/[^\s?#"']+)([?#][^\s"']*)?/g, (m, u, q) => (q ? u + "?…" : m));
    s = s.replace(/(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "<email>");
    s = s.replace(/(?<![A-Za-z0-9+/_-])(?=[A-Za-z0-9+/_-]*[0-9])(?=[A-Za-z0-9+/_-]*[A-Za-z])[A-Za-z0-9+/_-]{40,}={0,2}/g, "<key>");
    for (const n of names || []) {
      const v = String(n || "").trim();
      if (v.length >= 3) s = s.replace(new RegExp(reEsc(v), "gi"), "<потребител>");
      // also each part of a two-word name ("Иван Петров" -> "Иван", "Петров") when long enough to be safe
      for (const part of v.split(/\s+/)) if (part.length >= 4 && part !== v) s = s.replace(new RegExp(`(^|[^\\p{L}])${reEsc(part)}(?![\\p{L}])`, "giu"), "$1<потребител>");
    }
    s = s.replace(/\s+/g, " ").trim();
    return s.length > MSG_MAX ? s.slice(0, MSG_MAX) + "…" : s;
  }
  /** One argument (Error, event reason, object) as text. */
  function textOf(a) {
    if (a == null) return String(a);
    if (a instanceof Error || (a && typeof a.message === "string" && (a.stack || a.name))) {
      const st = a.status != null ? ` (status ${a.status})` : "";
      return `${a.name && a.name !== "Error" ? a.name + ": " : ""}${a.message}${st}`;
    }
    if (typeof a === "object") { try { return JSON.stringify(a); } catch { return String(a); } }
    return String(a);
  }

  /** Record one entry. level: "error" | "warn" | "info". The same message right after itself is counted, not repeated. */
  function log(level, msg, when) {
    const lv = /^err/i.test(level) ? "error" : /^warn/i.test(level) ? "warn" : "info";
    const text = clean(Array.isArray(msg) ? msg.map(textOf).join(" ") : textOf(msg), cfg.redact);
    if (!text) return;
    const last = entries[entries.length - 1];
    if (last && last.level === lv && last.msg === text) { last.n++; last.t = when || new Date(); return; }
    entries.push({ t: when || new Date(), level: lv, msg: text, n: 1 });
    if (entries.length > MAX) entries = entries.slice(-MAX);
  }

  /** Panel name, project id, version, names to hide, language getter. Fields left out keep their value. */
  function set(o) {
    for (const k of ["panel", "projectId", "version", "lang"]) if (o && o[k] != null) cfg[k] = o[k];
    if (o && Array.isArray(o.redact)) cfg.redact = [...new Set([...cfg.redact, ...o.redact.filter(Boolean).map(String)])];
    labels();
  }

  /** The text for Teams. info: {panel, version, projectId, now, page}. */
  function text(info) {
    const l = L(), i = Object.assign({ panel: cfg.panel, version: cfg.version, projectId: cfg.projectId, now: new Date() }, info || {});
    const head = [`${l.title}`,
      `${l.panel}: ${i.panel || "?"} · ${l.version} ${i.version || "?"} · ${l.project} ${i.projectId || "?"}`,
      `${l.at}: ${ymdhm(i.now)}${i.page ? ` · ${l.page}: ${clean(i.page)}` : ""}`];
    const lines = entries.map((e) => `${hms(e.t)} [${e.level}] ${e.msg}${e.n > 1 ? ` (×${e.n})` : ""}`);
    return [...head, "", lines.length ? `${l.last} (${lines.length}):` : l.none, ...lines].join("\n");
  }

  // ---------- browser ----------
  const doc = () => (root && root.document) || null;
  async function versionJson() {
    if (!root || typeof root.fetch !== "function") return null;
    const ctl = typeof AbortController === "function" ? new AbortController() : null;
    const tm = setTimeout(() => { try { if (ctl) ctl.abort(); } catch {} }, 2000);
    try {
      const r = await root.fetch("version.json?nc=" + Date.now(), { cache: "no-store", signal: ctl ? ctl.signal : undefined });
      return r && r.ok ? await r.json() : null;
    } catch { return null; } finally { clearTimeout(tm); }
  }
  async function writeClipboard(s) {
    try { if (root.navigator && root.navigator.clipboard && root.navigator.clipboard.writeText) { await root.navigator.clipboard.writeText(s); return true; } } catch {}
    const d = doc(); if (!d) return false;
    const ta = d.createElement("textarea");
    ta.value = s; ta.setAttribute("readonly", ""); ta.style.cssText = "position:fixed;left:-9999px;top:0";
    d.body.appendChild(ta); ta.select();
    let ok = false; try { ok = d.execCommand("copy"); } catch {}
    ta.remove();
    return ok;
  }
  /** Clipboard blocked (Connect's iframe may not allow it): show the text selected, to copy by hand. */
  function showText(s, near) {
    const d = doc(); if (!d) return;
    let box = d.getElementById("arsten-diag-box");
    if (!box) {
      box = d.createElement("div"); box.id = "arsten-diag-box";
      box.style.cssText = "margin:6px 0;border:1px solid var(--line,#d9d5cc);background:var(--panel,#fff);padding:6px";
      box.innerHTML = `<div class="sub" style="margin-bottom:4px"></div><textarea readonly style="width:100%;height:140px;font:11px Ubuntu Mono,monospace"></textarea><button class="small secondary" type="button"></button>`;
      (near && near.parentNode ? near.parentNode : d.body).insertBefore(box, near ? near.nextSibling : null);
      box.querySelector("button").onclick = () => box.remove();
    }
    box.querySelector("div").textContent = L().failed;
    box.querySelector("button").textContent = L().close;
    const ta = box.querySelector("textarea"); ta.value = s; ta.focus(); ta.select();
  }
  function labels() {
    const d = doc(); if (!d || !d.querySelectorAll) return;
    d.querySelectorAll("[data-arsten-diag]").forEach((b) => { if (!b.dataset.busy) b.textContent = L().label; });
  }
  /** Copy the text (version.json read first when there). Returns true when it reached the clipboard. */
  async function copy(btn) {
    const v = await versionJson();
    const loc = root && root.location ? String(root.location.origin || "") + String(root.location.pathname || "") : "";
    const s = text({ panel: cfg.panel || (v && v.panel) || (doc() && doc().title) || "", version: v && v.id ? `${v.id}${cfg.version ? " / " + cfg.version : ""}` : cfg.version || "dev", page: loc });
    const ok = await writeClipboard(s);
    if (btn) {
      btn.dataset.busy = "1"; btn.textContent = ok ? L().copied : L().label;
      setTimeout(() => { delete btn.dataset.busy; labels(); }, 2500);
    }
    if (!ok) showText(s, btn);
    return ok;
  }

  function install() {
    if (!root || root.__arstenDiagOn || typeof root.addEventListener !== "function") return;
    root.__arstenDiagOn = true;
    root.addEventListener("error", (e) => {
      if (e && e.target && e.target !== root && e.target.tagName) log("error", `load failed: ${e.target.tagName.toLowerCase()} ${e.target.src || e.target.href || ""}`);
      else log("error", e && e.error ? e.error : `${(e && e.message) || "error"}${e && e.filename ? ` (${String(e.filename).split("/").pop()}:${e.lineno})` : ""}`);
    }, true);
    root.addEventListener("unhandledrejection", (e) => log("error", ["unhandled:", e && e.reason]));
    const c = root.console;
    if (c) for (const lv of ["error", "warn"]) {
      const orig = c[lv];
      if (typeof orig !== "function" || orig.__arstenDiag) continue;
      const wrapped = function (...a) { try { log(lv, a); } catch {} return orig.apply(this, a); };
      wrapped.__arstenDiag = true;
      c[lv] = wrapped;
    }
    const d = doc();
    if (d && d.addEventListener) {
      d.addEventListener("click", (e) => {
        const b = e.target && e.target.closest ? e.target.closest("[data-arsten-diag]") : null;
        if (b) { e.preventDefault(); copy(b); }
        else if (typeof requestAnimationFrame === "function") requestAnimationFrame(labels);   // a language switch may have happened
      });
      d.addEventListener("change", () => { if (typeof requestAnimationFrame === "function") requestAnimationFrame(labels); });
      if (d.readyState === "loading") d.addEventListener("DOMContentLoaded", labels); else labels();
    }
  }
  if (root && root.document) install();

  // relabel(): the button text in the current language, for a panel's language switch (round 19 L4)
  return { MAX, log, set, relabel: labels, copy, text, clean, entries: () => entries.slice(), _reset: () => { entries = []; Object.assign(cfg, { panel: "", projectId: "", version: "", redact: [], lang: null }); } };
});
