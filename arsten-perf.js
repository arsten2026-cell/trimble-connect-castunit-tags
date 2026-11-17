// Arsten / Multiplan call instrumentation for the Connect panels (review round 12, "?perf=1").
//
// Off by default: nothing is counted and every hook returns at once. On when sessionStorage["arsten.perf"] === "1".
//  - Open any panel (or the shell) with ?perf=1 in its URL: this file stores the flag (?perf=0 clears it). All panels and
//    the shell share one origin, so the flag covers every tool iframe of the browser tab.
//  - Or by hand in the console: sessionStorage.setItem("arsten.perf", "1").
// Then, in the console of a panel's frame: ArstenPerf.report() prints a table per service (pset / org / core) and call
// kind: count, errors, retries (429 / 503), timeouts, total / average / p50 / p95 / max ms, and the peak number of calls
// running at the same time (per service and overall). ArstenPerf.reset() starts again. ArstenPerf.dump() gives the rows.
//
// Used (when loaded, i.e. present as window.ArstenPerf) by psetapi.js (PsetClient.request: pset-api and org-api) and by
// the Core clients of arsten-access.js, arsten-photos.js and arsten-backup.js. Load it BEFORE them in index.html.
// Each frame (panel) has its own window.ArstenPerf and so its own numbers.
(function (root, factory) {
  const lib = factory(root);
  if (typeof module === "object" && module.exports) module.exports = lib;
  else root.ArstenPerf = lib;
})(typeof self !== "undefined" ? self : this, function (root) {
  "use strict";
  const KEY = "arsten.perf";
  const store = () => { try { return typeof sessionStorage !== "undefined" && sessionStorage ? sessionStorage : null; } catch { return null; } };

  // ?perf=1 / ?perf=0 in this page's URL sets / clears the flag for the whole tab
  try {
    const loc = (root && root.location) || (typeof globalThis !== "undefined" ? globalThis.location : null);
    const q = loc && typeof loc.search === "string" ? loc.search : "";
    const m = /[?&]perf=([01])(?:&|$)/.exec(q);
    const st = store();
    if (m && st) { if (m[1] === "1") st.setItem(KEY, "1"); else st.removeItem(KEY); }
  } catch {}

  let forced = null;   // tests: _setEnabled(true / false / null)
  /** Is instrumentation on? Read on every call, so setting the flag by hand works without a reload. */
  function enabled() {
    if (forced !== null) return forced;
    const st = store();
    try { return !!st && st.getItem(KEY) === "1"; } catch { return false; }
  }
  const clock = () => (typeof performance !== "undefined" && performance && typeof performance.now === "function" ? performance.now() : Date.now());

  let stats = new Map();      // "svc|kind" -> row
  let active = new Map();     // svc -> calls running
  let peaks = new Map();      // svc -> peak running
  let all = { active: 0, peak: 0 };

  /** Call kind from a path: query dropped, id-like segments (digits, %, long or mixed) shown as "*". */
  function kindOf(method, path) {
    const segs = String(path || "").split("?")[0].split("/").filter(Boolean)
      .map((s) => (/^[A-Za-z][A-Za-z-]{0,23}$/.test(s) && !/[0-9%]/.test(s) ? s : "*"));
    return `${String(method || "GET").toUpperCase()} ${segs.join("/") || "/"}`;
  }
  function row(svc, kind) {
    const k = svc + "|" + kind;
    let r = stats.get(k);
    if (!r) { r = { svc, kind, count: 0, errors: 0, retries: 0, timeouts: 0, totalMs: 0, maxMs: 0, ms: [] }; stats.set(k, r); }
    return r;
  }

  /**
   * One call starts. Returns a handle for end(), or null when off (then end(null) does nothing).
   * @param svc "pset" | "org" | "core" | any name
   */
  function start(svc, method, path) {
    if (!enabled()) return null;
    const n = (active.get(svc) || 0) + 1;
    active.set(svc, n);
    if (n > (peaks.get(svc) || 0)) peaks.set(svc, n);
    all.active++; if (all.active > all.peak) all.peak = all.active;
    return { svc, kind: kindOf(method, path), t0: clock() };
  }
  /** The call ended. status: HTTP status, 0 for a network error, "timeout" for a timeout. */
  function end(h, status) {
    if (!h) return;
    const ms = clock() - h.t0;
    active.set(h.svc, Math.max(0, (active.get(h.svc) || 1) - 1));
    all.active = Math.max(0, all.active - 1);
    const r = row(h.svc, h.kind);
    r.count++; r.totalMs += ms; if (ms > r.maxMs) r.maxMs = ms;
    if (r.ms.length < 5000) r.ms.push(ms);
    if (status === "timeout") r.timeouts++;
    else if (!(typeof status === "number" && status >= 200 && status < 400)) r.errors++;
  }
  /** A 429 / 503 retry of a call (counted on its kind). */
  function retry(svc, method, path) {
    if (!enabled()) return;
    row(svc, kindOf(method, path)).retries++;
  }

  const pct = (list, p) => {
    if (!list.length) return 0;
    const s = list.slice().sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))];
  };
  const r1 = (x) => Math.round(x * 10) / 10;
  /** Rows: one per service and call kind, then one total per service (kind "(all)"), sorted by total time. */
  function dump() {
    const rows = [...stats.values()].map((r) => ({ service: r.svc, call: r.kind, count: r.count, errors: r.errors, retries: r.retries,
      timeouts: r.timeouts, totalMs: r1(r.totalMs), avgMs: r1(r.count ? r.totalMs / r.count : 0), p50: r1(pct(r.ms, 50)), p95: r1(pct(r.ms, 95)),
      maxMs: r1(r.maxMs), peak: "" }));
    rows.sort((a, b) => b.totalMs - a.totalMs);
    const svcs = [...new Set([...stats.values()].map((r) => r.svc))].sort();
    for (const svc of svcs) {
      const list = [...stats.values()].filter((r) => r.svc === svc);
      const ms = [].concat(...list.map((r) => r.ms));
      const sum = (f) => list.reduce((a, r) => a + r[f], 0);
      const count = sum("count"), total = sum("totalMs");
      rows.push({ service: svc, call: "(all)", count, errors: sum("errors"), retries: sum("retries"), timeouts: sum("timeouts"),
        totalMs: r1(total), avgMs: r1(count ? total / count : 0), p50: r1(pct(ms, 50)), p95: r1(pct(ms, 95)),
        maxMs: r1(Math.max(0, ...list.map((r) => r.maxMs))), peak: peaks.get(svc) || 0 });
    }
    return rows;
  }
  /** Print the table in the console (console.table) and return the rows. */
  function report() {
    const rows = dump();
    const c = typeof console !== "undefined" ? console : null;
    if (c) {
      if (!enabled() && !rows.length) c.log("ArstenPerf is off: sessionStorage.setItem('arsten.perf','1') or open a panel with ?perf=1, then reload.");
      if (typeof c.table === "function") c.table(rows); else c.log(rows);
      c.log(`ArstenPerf: peak calls at once (all services) ${all.peak}; now running ${all.active}`);
    }
    return rows;
  }
  function reset() { stats = new Map(); peaks = new Map(); active = new Map(); all = { active: 0, peak: 0 }; }
  const peak = (svc) => (svc ? peaks.get(svc) || 0 : all.peak);

  return { KEY, enabled, start, end, retry, kindOf, dump, report, reset, peak, _setEnabled: (v) => { forced = v == null ? null : !!v; } };
});
