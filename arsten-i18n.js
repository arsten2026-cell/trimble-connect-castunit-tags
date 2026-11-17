// Arsten / Multiplan: one language setting, one date format and a few shared words for all Connect panels (week 4, A10).
//
//  - Language: localStorage "arsten.lang" ("bg" | "en"). All panels and the shell share one origin, so they share it.
//    Each panel keeps its own BG/EN switch and writes this key (setLang). Old per-panel keys ("arsten.pourStatus.lang",
//    ...) are read once when the shared key is empty and then copied into it.
//    Default when nothing is stored: the Connect user's language (pickLang), else Bulgarian.
//  - fmtDate: BG DD.MM.YYYY, EN "3 Nov 2026"; {time:true} adds HH:MM; {short:true} gives DD.MM.YY (tables).
//    Stored records and file names stay ISO; this is for display only.
//  - fmtNum: BG "3 292" / "37,9", EN "3,292" / "37.9".
//  - plural: Bulgarian counted form ("1 такт" / "2 такта").
//  - err: errors start with "Грешка:" / "Error:".
//  - logText: a stored history line (English, parsers rely on it) shown in Bulgarian. The stored text is NOT changed.
// Master: shared/arsten-i18n.js (copied into each panel by `node scripts/release.mjs sync`).
// Load it in index.html after arsten-perf.js and before app.js. Browser: window.ArstenI18n; Node: module.exports.
(function (root, factory) {
  const lib = factory();
  if (typeof module === "object" && module.exports) module.exports = lib;
  else root.ArstenI18n = lib;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";
  const KEY = "arsten.lang";
  const OLD_KEYS = ["arsten.pourStatus.lang", "arsten.assemblyStatus.lang", "arsten.acceptance.lang", "arsten.projectStatus.lang", "arsten.admin.lang"];
  let mem = "";   // when storage is blocked, the choice still holds for this page
  const store = () => { try { return typeof localStorage !== "undefined" && localStorage ? localStorage : null; } catch { return null; } };
  const norm = (l) => (l === "bg" || l === "en" ? l : "");

  /** The stored language ("bg" | "en"), or "" when none was chosen yet. oldKeys: this panel's old key(s) first. */
  function stored(oldKeys) {
    const st = store();
    try {
      const v = norm(st && st.getItem(KEY));
      if (v) return v;
      for (const k of [].concat(oldKeys || [], OLD_KEYS)) {
        const o = norm(st && st.getItem(k));
        if (o) { try { st.setItem(KEY, o); } catch {} return o; }
      }
    } catch {}
    return mem;
  }
  /** The language to start with, synchronously: the stored one, else Bulgarian. */
  const getLang = (oldKeys) => stored(oldKeys) || "bg";
  /** The user switched the language in a panel: every panel (and the shell) starts with it from now on. */
  function setLang(l) {
    const v = norm(l) || "bg";
    mem = v;
    const st = store();
    try { if (st) st.setItem(KEY, v); } catch {}
    return v;
  }
  /** "bg" for a Bulgarian locale ("bg", "bg-BG"), "en" for any other non-empty one, "" for none. */
  const fromLocale = (l) => (!l ? "" : /^bg\b/i.test(String(l)) ? "bg" : "en");
  /**
   * The language to use once the Connect API is there: the stored choice; else the Connect user's language
   * (api.user.getSettings().language, then access.user.language); else Bulgarian. Never writes the key (only a
   * switch by the user does), so a later change of the Connect language still counts.
   */
  async function pickLang(api, access, oldKeys) {
    const s = stored(oldKeys);
    if (s) return s;
    let l = "";
    try { const u = api && api.user && typeof api.user.getSettings === "function" ? await api.user.getSettings() : null; l = (u && u.language) || ""; } catch {}
    if (!l) l = (access && access.user && access.user.language) || "";
    return fromLocale(l) || "bg";
  }

  const pad = (n) => String(n).padStart(2, "0");
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  /** {y, m, d, hh, mm} from "YYYY-MM-DD", "YYYY-MM-DD HH:MM", an ISO time or a Date; null if it is not a date. */
  function parts(v) {
    if (v instanceof Date) return isNaN(v) ? null : { y: v.getFullYear(), m: v.getMonth() + 1, d: v.getDate(), hh: v.getHours(), mm: v.getMinutes(), t: true };
    const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/.exec(String(v == null ? "" : v).trim());
    if (!m) return null;
    return { y: +m[1], m: +m[2], d: +m[3], hh: m[4] != null ? +m[4] : 0, mm: m[5] != null ? +m[5] : 0, t: m[4] != null };
  }
  /**
   * A date for display. lang "bg": 03.11.2026; "en": 3 Nov 2026. opts.short: 03.11.26 (both languages, for tables).
   * opts.time: adds " HH:MM" when the value has a time. Not a date: the text as it is ("" for empty).
   */
  function fmtDate(iso, lang, opts) {
    const o = opts || {};
    const p = parts(iso);
    if (!p) return iso == null ? "" : String(iso);
    let s;
    if (o.short) s = `${pad(p.d)}.${pad(p.m)}.${String(p.y).slice(2)}`;
    else if (lang === "en") s = `${p.d} ${MONTHS[p.m - 1] || p.m} ${p.y}`;
    else s = `${pad(p.d)}.${pad(p.m)}.${p.y}`;
    if (o.time && p.t) s += ` ${pad(p.hh)}:${pad(p.mm)}`;
    return s;
  }

  /**
   * A number for display. lang "bg": "3 292" / "37,9" (non-breaking space between thousands from 1 000 on, decimal comma);
   * "en": "3,292" / "37.9". digits: at most this many decimals (default 0), trailing zeros dropped; opts.fixed: always
   * that many. Not a finite number: "" for null/empty, else the text as it is.
   */
  function fmtNum(v, lang, digits, opts) {
    if (v == null || v === "") return "";
    const n = Number(v);
    if (!isFinite(n)) return String(v);
    const d = Math.max(0, Math.min(6, digits | 0));
    let s = (Math.round(Math.abs(n) * 10 ** d) / 10 ** d).toFixed(d);
    if (!(opts && opts.fixed) && d) s = s.replace(/\.?0+$/, "");
    let [int, frac] = s.split(".");
    int = int.replace(/\B(?=(\d{3})+(?!\d))/g, lang === "en" ? "," : " ");
    const neg = n < 0 && /[1-9]/.test(s);
    return (neg ? "-" : "") + int + (frac ? (lang === "en" ? "." : ",") + frac : "");
  }

  /** Bulgarian counted form: one for 1 (and -1), many otherwise. Returns the word only: `${n} ${plural(n, "такт", "такта")}`. */
  const plural = (n, one, many) => (Math.abs(Number(n)) === 1 ? one : many);

  const errMsg = (e) => (e == null ? "" : typeof e === "string" ? e : (e.message || String(e)));
  /** "Грешка: …" / "Error: …" (an existing prefix is not doubled). */
  function err(e, lang) {
    const msg = errMsg(e).replace(/^(?:Error|Грешка)\s*:\s*/i, "");
    return (lang === "en" ? "Error: " : "Грешка: ") + msg;
  }

  // words every panel shows the same way
  const WORDS = {
    connecting: ["Свързване с Trimble Connect…", "Connecting to Trimble Connect…"],
    connectFail: ["Няма връзка с Trimble Connect", "Could not connect to Trimble Connect"],
    notInside: ["Не е отворено в Trimble Connect. Добавете разширението към проекта и го отворете от страничния панел на 3D изгледа.",
      "Not inside Trimble Connect. Add this extension to a project and open it from the 3D viewer side panel."],
    loading: ["Зареждане…", "Loading…"],
    saved: ["записано", "saved"],
    backupSaved: ["Архивът е запазен", "Backup saved"],
    done: ["Готово", "Done"],
    remove: ["Премахни", "Remove"],
    brand: ["Arsten / Multiplan", "Arsten / Multiplan"],
  };
  const word = (k, lang) => (WORDS[k] ? WORDS[k][lang === "en" ? 1 : 0] : k);
  /** One wording for success messages: "<етап>: записано N" / "<stage>: saved N". */
  const savedMsg = (what, n, lang) => `${what}: ${word("saved", lang)} ${n}`;

  // ---------- stored history lines shown in Bulgarian (display only) ----------
  const STEP_BG = {
    "formwork done": "Кофраж готов", "rebar done": "Армировка готова", "poured": "Излят", "formwork removed": "Декофриран",
    "formwork": "кофраж", "rebar": "армировка", "both": "кофраж и армировка", "concrete": "бетон",
    "erected": "монтиран", "wrong": "грешка", "hold": "задържан",
  };
  const DEC_BG = { approved: "одобрено", remarks: "одобрено със забележки", rejected: "не се приема" };
  const stepBg = (s) => STEP_BG[String(s).toLowerCase()] || s;
  const isoDates = (s) => s.replace(/\b(\d{4})-(\d{2})-(\d{2})\b/g, (_, y, m, d) => `${d}.${m}.${y}`);
  // [pattern of the action part (start of the text), replacement] - first match wins
  const RULES = [
    [/^(done|corrected): (Formwork done|Rebar done|Poured|Formwork removed) /, (_, v, s) => `${v === "done" ? "готово" : "поправено"}: ${stepBg(s)} `],
    [/^undone: (Formwork done|Rebar done|Poured|Formwork removed|erected|wrong|hold) by /, (_, s) => `отменено: ${stepBg(s)} от `],
    [/^without: (Formwork done|Rebar done|Poured|Formwork removed) /, (_, s) => `без: ${stepBg(s)} `],
    [/^note: (Formwork done|Rebar done|Poured|Formwork removed)/, (_, s) => `бележка: ${stepBg(s)}`],
    [/^inherited: (Formwork done|Rebar done|Poured|Formwork removed) /, (_, s) => `наследено: ${stepBg(s)} `],
    [/^split: (\d+) new piece\(s\) got formwork\/rebar, by /, (_, n) => `разделяне: ${n} ${plural(n, "нова част получи", "нови части получиха")} кофраж/армировка, от `],
    [/^split checked, nothing passed on, by /, () => "разделянето е проверено, нищо не е предадено, от "],
    [/^merged back: pour break removed, (\d+) piece\(s\) \(([^)]*)\), by /, (_, n, g) => `обединено обратно: фугата е премахната, ${n} ${plural(n, "част", "части")} (${g}), от `],
    [/^merged back: pour break removed, (\d+) piece\(s\)/, (_, n) => `обединено обратно: фугата е премахната, ${n} ${plural(n, "част", "части")}`],
    [/^merged into (\S+) \(pour break removed\), by /, (_, g) => `обединено в ${g} (фугата е премахната), от `],
    [/^(set|corrected): (erected|wrong|hold) /, (_, v, s) => `${v === "set" ? "отбелязано" : "поправено"}: ${stepBg(s)} `],
    // the source is a file name and may hold ")" or " – " ("Доставка (2).xlsx"): matched on the whole first line, up to the last "): "
    [/^created by (.+?) \((.*)\): /, (_, who, src) => `създадено от ${who} (${src === "typed" ? "въведено" : src}): `],
    [/^re-attached from (\S+) by /, (_, g) => `прехвърлено от ${g}, от `],
    [/^cancelled by /, () => "анулирано от "],
    [/^requested \((\w+), (\d+) photos?\) by /, (_, s, n) => `заявено (${stepBg(s)}, ${n} ${plural(n, "снимка", "снимки")}) от `],
    [/^sent to the designer by (.+?)(?: \(ToDo ([^)]*)\))?$/, (_, who, id) => `изпратено към проектанта от ${who}${id ? ` (задача ${id})` : ""}`],
    [/^photos \+(\d+) by /, (_, n) => `снимки +${n} от `],
    [/^round (\d+): (approved|remarks|rejected) by /, (_, r, d) => `кръг ${r}: ${DEC_BG[d]} от `],
  ];
  const TAILS = [
    [/ – reopened after rejection \(round (\d+)\)/, (_, r) => ` – отворено отново след отказ (кръг ${r})`],
    [/ \(cleared\)/, () => " (изтрита)"],
    [/ – pour break, by /, () => " – фуга, от "],
  ];
  /**
   * A stored history entry for display. lang "en": as stored. lang "bg": the fixed verbs in Bulgarian and ISO dates
   * as DD.MM.YYYY; names, notes and comments untouched. Works on the action text ("done: Poured 2026-11-16 by X") and on
   * a whole line with its stamp ("2026-11-13 09:10 requested (rebar, 2 photos) by X"). Unknown lines: dates only.
   */
  function logText(line, lang) {
    const s = String(line == null ? "" : line);
    if (lang === "en") return s;
    const m = /^(\d{4}-\d{2}-\d{2}) (?:(\d{2}:\d{2}) )?([\s\S]*)$/.exec(s);
    const head = m ? `${fmtDate(m[1], "bg")} ${m[2] ? m[2] + " " : ""}` : "";
    let what = m ? m[3] : s;
    // only the first line (the action); continuation lines are note text
    const nl = what.indexOf("\n");
    let first = nl < 0 ? what : what.slice(0, nl);
    const rest = nl < 0 ? "" : what.slice(nl);
    // the note starts at the first " – "; the action is before it
    // ("created by" lines: the source file name may hold " – ", so the whole line is the action)
    const cut = /^created by /.test(first) ? -1 : first.indexOf(" – ");
    let action = cut < 0 ? first : first.slice(0, cut), note = cut < 0 ? "" : first.slice(cut);
    for (const [re, fn] of RULES) if (re.test(action)) { action = action.replace(re, fn); break; }
    if (/^(?:готово|поправено|без|отбелязано): /.test(action)) action = action.replace(/ by /, " от ");
    if (/^наследено: /.test(action)) action = action.replace(/ from (\S+)$/, " от $1");
    for (const [re, fn] of TAILS) { note = note.replace(re, fn); action = action.replace(re, fn); }
    // pour-status "note:" lines put "by <author>" after the note (or after "(cleared)"): the LAST " by " is the author's,
    // a " by " inside the note is the note's own text
    if (/^бележка: /.test(action)) { if (note) note = note.replace(/^([\s\S]*) by ([^–]*)$/, "$1 от $2"); else action = action.replace(/^([\s\S]*) by ([^–]*)$/, "$1 от $2"); }
    first = isoDates(action) + note;
    return head + first + rest;
  }

  return { KEY, OLD_KEYS, stored, getLang, setLang, fromLocale, pickLang, fmtDate, fmtNum, plural, err, word, savedMsg, logText, WORDS };
});
