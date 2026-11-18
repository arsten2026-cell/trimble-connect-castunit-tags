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
//  - err: errors start with "Грешка:" / "Error:"; friendly: an error in plain words with what to do (sweep 18.11.2026).
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

  // ---------- errors in plain words (sweep 18.11.2026) ----------
  // Users saw raw API texts ("Грешка: upload PUT 413", "Core PATCH …: 500", "folder not created: …") and a Bulgarian
  // timeout text in English. friendly(e, lang) says what happened and what to do, by e.status / e.timeout; the raw
  // message goes to the console (and so to "Копирай диагностика"). An error WITHOUT a status whose text is not technical
  // (a panel's own sentence, e.g. "Нямате права…") is shown as it is.
  const FRIENDLY = {
    net: ["Няма връзка с Connect – проверете интернета и опитайте пак.", "No connection to Connect – check the internet and try again."],
    busy: ["Connect е зает – опитайте след минута.", "Connect is busy – try again in a minute."],
    auth: ["Сесията изтече – презаредете страницата.", "Session expired – reload the page."],
    denied: ["Нямате права за това в Connect.", "You have no permission for this in Connect."],
    noAccess: ["Нямате достъп до папката в Connect – помолете администратора на проекта.", "No access to the folder in Connect – ask the project administrator."],
    // sweep 18.11.2026: most panels (Монолитен бетон, Стомана, Дейности, Статус) have no Обнови button, so the default
    // says to reopen the panel; a panel WITH the button passes {refresh: "button"} (changedButton)
    changed: ["Данните са променени от друг потребител – затворете и отворете панела отново.", "Someone else changed this – close and reopen the panel."],
    changedButton: ["Данните са променени междувременно – натиснете Обнови.", "The data changed meanwhile – press Refresh."],
    big: ["Снимката е твърде голяма.", "The photo is too large."],
    cut: ["Папката в Connect има твърде много файлове – преместете излишните и опитайте пак.", "The folder in Connect holds too many files – move the extra ones out and try again."],
    other: ["Нещо се обърка – опитайте пак; ако се повтаря, натиснете „Копирай диагностика“.", "Something went wrong – try again; if it repeats, press \"Copy diagnostics\"."],
  };
  const TECH = /^(?:Core |upload|files?\/|folders?\b|folder not|photo|activities|PATCH|PUT|GET|POST|DELETE|HTTP|request|fetch)|\b[45]\d\d\b|TypeError|ReferenceError|SyntaxError|undefined|\bnull\b|Failed to fetch|NetworkError|Load failed|aborted|AbortError/i;
  const NET = /Failed to fetch|NetworkError|Load failed|network|не отговаря/i;
  /** The plain sentence for an error. opts.noWrite: the panel's own 403 text ("no permission to write to <library>");
   *  opts.refresh: "button" when the panel has an Обнови / Refresh button, else (default) "reopen the panel". */
  function friendly(e, lang, opts) {
    const i = lang === "en" ? 1 : 0, o = opts || {};
    const msg = errMsg(e), st = e && typeof e === "object" ? Number(e.status) : NaN;
    const say = (k) => { if (msg) console.warn("[error]", msg); return FRIENDLY[k][i]; };
    if (e && e.noAccess) return say("noAccess");
    if (e && e.code === "FOLDER_LISTING_CUT") return say("cut");
    if ((e && e.timeout) || st === 0 || (!isFinite(st) && NET.test(msg))) return say("net");
    if (st === 429 || st === 503 || st === 502 || st === 504) return say("busy");
    if (st === 401) return say("auth");
    if (st === 403) { if (msg) console.warn("[error]", msg); return o.noWrite || FRIENDLY.denied[i]; }
    if (st === 404 || st === 409 || st === 412) return say(o.refresh === "button" ? "changedButton" : "changed");
    if (st === 413) return say("big");
    if (isFinite(st) && st) return say("other");
    if (!msg || TECH.test(msg)) return say("other");
    return msg.replace(/^(?:Error|Грешка)\s*:\s*/i, "");
  }
  /** "Няма връзка…" -> "няма връзка…" inside a sentence; "Connect е зает" stays. */
  const lowerFirst = (s) => (/^[A-ZА-Я][a-zа-я]/.test(s) && !/^(?:Connect|Trimble)\b/.test(s) ? s.charAt(0).toLowerCase() + s.slice(1) : s);
  /**
   * The result of a batch (several pours / pieces saved one by one) in plain words, result first (sweep 18.11.2026:
   * "Кофраж: записано 0 · 3 грешки (Failed to fetch)" did not say whether anything was saved or what to do).
   * e: the first error (friendly(), the raw text to the console). opts: friendly's opts plus units {bg: [one, many],
   * en: [one, many]} for "за 3 такта" / "for 3 pours".
   *   all saved:  "Кофраж: записано 3"
   *   none saved: "Кофраж: не е записано за 3 такта – няма връзка с Connect – проверете интернета и опитайте пак."
   *   some saved: "Кофраж: записано 2, незаписано 1 – …"
   */
  function batchText(what, saved, failed, e, lang, opts) {
    const en = lang === "en", o = opts || {};
    saved = Number(saved) || 0; failed = Number(failed) || 0;
    if (!failed) return savedMsg(what, saved, lang);
    const why = lowerFirst(friendly(e, lang, o));
    const u = o.units && o.units[en ? "en" : "bg"];
    const unit = u ? ` ${en ? "for" : "за"} ${failed} ${plural(failed, u[0], u[1])}` : "";
    if (!saved) return en ? `${what}: not saved${unit} – ${why}` : `${what}: не е записано${unit} – ${why}`;
    return en ? `${what}: ${saved} saved, ${failed} not saved – ${why}` : `${what}: записано ${saved}, незаписано ${failed} – ${why}`;
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

  // ---------- the Workspace API script did not load (sweep 18.11.2026) ----------
  // Every index.html loads trimble-connect-workspace-api from cdn.jsdelivr.net (with an SRI hash). When jsdelivr is slow
  // or blocked (weak site link, company firewall, captive portal) or the hash check fails, TrimbleConnectWorkspace is
  // missing, connect() throws a ReferenceError and the panel stayed on "Свързване…" for ever with no reason and no retry.
  // Each app.js calls workspaceMissing(lang, {setStatus, el}) before connect(): true = missing; the status line then says
  // so in plain words and a "Опитай пак" button reloads the page. The <script> tag's onerror can call it too.
  const NO_WORKSPACE = ["модулът на Connect не се зареди – проверете интернета (или мрежовата защита) и опитайте пак.",
    "the Connect module did not load – check the internet (or the network firewall) and try again."];
  const RETRY = ["Опитай пак", "Try again"];
  /** The plain sentence shown when the Workspace API is missing. */
  const workspaceText = (lang) => `${word("connectFail", lang)} – ${NO_WORKSPACE[lang === "en" ? 1 : 0]}`;
  /**
   * true when the Workspace API script is not there (and the message and a retry button are shown); false when it is.
   * o: {setStatus(text, bad)?, el? (element the button goes after; default #status, else the end of <body>),
   *     global? (tests), reload? (tests; default location.reload)}
   */
  function workspaceMissing(lang, o) {
    o = o || {};
    const g = o.global || (typeof globalThis !== "undefined" ? globalThis : typeof self !== "undefined" ? self : {});
    if (g.TrimbleConnectWorkspace && typeof g.TrimbleConnectWorkspace.connect === "function") return false;
    const text = workspaceText(lang);
    console.warn("[error] TrimbleConnectWorkspace is not loaded (CDN blocked, slow or SRI mismatch)");
    try {
      if (o.setStatus) o.setStatus(text, true);
      const doc = g.document;
      if (doc && doc.createElement) {
        const at = o.el || (doc.getElementById && doc.getElementById("status")) || null;
        if (!o.setStatus && at) at.textContent = text;
        if (!(doc.querySelector && doc.querySelector("[data-arsten-retry]"))) {
          const b = doc.createElement("button");
          b.type = "button"; b.className = "small"; b.textContent = RETRY[lang === "en" ? 1 : 0];
          b.setAttribute("data-arsten-retry", "1");
          b.onclick = () => { try { (o.reload || (() => g.location.reload()))(); } catch {} };
          if (at && at.parentNode) at.parentNode.insertBefore(b, at.nextSibling);
          else if (doc.body) doc.body.appendChild(b);
        }
      }
    } catch (e) { console.warn("workspaceMissing: message not shown", e); }
    return true;
  }
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
  const BASIS = / \{for (.*?) · (formwork|rebar|both) · (\d+) photos #[0-9a-f]{8}\}/;
  const TAILS = [
    [/ – reopened after rejection \(round (\d+)\)/, (_, r) => ` – отворено отново след отказ (кръг ${r})`],
    [/ \(cleared\)/, () => " (изтрита)"],
    [/ – pour break, by /, () => " – фуга, от "],
    // what an acceptance decision was given for (arsten-acceptance.js basisTag, sweep 18.11.2026); the hash is not shown
    [BASIS, (_, p, s, n) => ` (за ${p} · ${stepBg(s)} · ${n} ${plural(n, "снимка", "снимки")})`],
  ];
  /**
   * A stored history entry for display. lang "en": as stored. lang "bg": the fixed verbs in Bulgarian and ISO dates
   * as DD.MM.YYYY; names, notes and comments untouched. Works on the action text ("done: Poured 2026-11-16 by X") and on
   * a whole line with its stamp ("2026-11-13 09:10 requested (rebar, 2 photos) by X"). Unknown lines: dates only.
   */
  function logText(line, lang) {
    const s = String(line == null ? "" : line);
    if (lang === "en") return s.replace(BASIS, (_, p, st, n) => ` (for ${p} · ${st} · ${n} photo${n === "1" ? "" : "s"})`);
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

  return { KEY, OLD_KEYS, stored, getLang, setLang, fromLocale, pickLang, fmtDate, fmtNum, plural, err, friendly, batchText, FRIENDLY, word, workspaceMissing, workspaceText, savedMsg, logText, WORDS };
});
