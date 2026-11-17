// Arsten access control for Trimble Connect extensions (role-based, fail closed).
//
// Roles, from the Connect project (ALL configuration is in GROUP_ROLES and APPS below):
//   admin  - project role ADMIN, or group "00_ADMIN"     -> everything
//   gc     - group "GENERAL CONTRACTOR" (1028: "02.GENERAL CONTRACTOR") -> execution extensions
//   client - group "CLIENT" ("01.CLIENT")                -> "Project status" (client viewer)
//   subcontractor / designer / viewer - groups "03.SUBCONTRACTORS" / "04.DESIGNERS" / "05.VIEWERS" -> nothing yet
//   none   - anyone else, or the role cannot be determined -> no access
// Several groups (round 11, M4): a person gets the UNION of their roles and capabilities. access.roles lists every role,
// an app is allowed when ANY of them is allowed, and access.role is one role for display (ROLE_ORDER; in check() the
// first of them that this app allows, so a client who is also a designer is "client" in Статус, "designer" in Стомана).
// Helpers: hasRole(access, r), canWrite(access) (may write statuses: CIP / STEEL Edit groups), side(access) ("office"/"site").
// Group names are matched without a leading number prefix ("02." / "00_" / "2 " / "02-"), case- and space-insensitively.
// To give a group access later: add its role to the app's list in APPS (or map the group to an existing role).
//
// Usage (browser, after TrimbleConnectWorkspace.connect):
//   const access = await ArstenAccess.check({ api, getToken, app: "execution" });   // or "admin", "projectStatus"
//   if (!access.allowed) { ArstenAccess.renderDenied(document.body, lang, access); return; }
// getToken(refresh) must return the extension's Connect access token (api.extension.requestPermission("accesstoken")).
// ArstenAccess.tokenGetter(api) gives one, if the extension has none; pass its onEvent the Workspace events.
//
// Core API (Trimble Connect 2.0, the user's own token, CORS *):
//   GET {core}/projects/{projectId}/users           -> [{id, email, role: "ADMIN"|"USER", tiduuid, status}]
//   GET {core}/groups?projectId={projectId}         -> [{id, name}]
//   GET {core}/groups/{groupId}/users               -> [{id, email, tiduuid}]
// No network calls in resolveRole / policy helpers, so they are unit-tested in Node.
(function (root, factory) {
  const lib = factory();
  if (typeof module === "object" && module.exports) module.exports = lib;
  else root.ArstenAccess = lib;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  /** Connect group name (without its number prefix) -> role. */
  const GROUP_ROLES = {
    "ADMIN": "admin",              // group "00_ADMIN": same rights as a Connect project admin
    "GENERAL CONTRACTOR": "gc",
    "CLIENT": "client",
    "SUBCONTRACTORS": "subcontractor",
    "DESIGNERS": "designer",
    "VIEWERS": "viewer",
    "STRUCTURAL DESIGNER": "designer",   // 1028: "4.1-STRUCTURAL DESIGNER" (also gives the "approve" capability below)
    "EXECUTION PROJECT MANAGER": "gc",    // "02.1-EXECUTION PROJECT MANAGER": general contractor side (+ "stages" below)
    "FABRICATOR": "fabricator",           // "06.FABRICATOR": separate company, fabrication panel only
  };
  /** Extra rights from a group, independent of the role (an admin in the group gets them too, other admins do not). */
  const GROUP_CAPS = {
    "STRUCTURAL DESIGNER": ["approve"],   // the one person who approves formwork / rebar acceptance (user, 13.11.2026)
    "EXECUTION PROJECT MANAGER": ["stages", "write"],   // manages the project's stages (Етапи) with 00_ADMIN (user, 15.11.2026)
    // 00_ADMIN also manages stages. Only through the group, like the library lock (Stages: Edit for 00_ADMIN + 02.1):
    // a Connect project admin outside 00_ADMIN is refused by pset-api, so the shell must not offer editing either.
    "ADMIN": ["stages", "write"],
    // "write" (round 11, M3): the groups with Edit on the CIP / STEEL status definitions (AM_TEMPLATE). pset-api gives a
    // Connect project ADMIN no PutPSet of its own, so an admin outside these groups gets the work panels read-only.
    "GENERAL CONTRACTOR": ["write"],
  };
  /** Which roles may use which kind of extension. Roles not listed anywhere have no access. */
  const APPS = { execution: ["admin", "gc"], admin: ["admin"], projectStatus: ["admin", "client", "gc"], assembly: ["admin", "gc", "designer"], acceptance: ["admin", "gc", "designer"] };   // projectStatus: GC too (user, 12.11)
  /** The role SHOWN when someone is in several groups (display only: rights are the union of all roles, round 11 M4).
   *  Same order as plugins/arsten-docs/src/roles.ts. */
  const ROLE_ORDER = ["admin", "gc", "designer", "client", "subcontractor", "fabricator", "viewer"];
  const DEFAULTS = { groupRoles: GROUP_ROLES, groupCaps: GROUP_CAPS, apps: APPS, cacheMinutes: 10 };
  const CORE = { northamerica: "app", europe: "app21", unitedkingdom: "app22", asia: "app31", australia: "app32" };

  const norm = (s) => String(s == null ? "" : s).normalize("NFC").replace(/\s+/g, " ").trim().toLowerCase();
  const sameUser = (a, b) => !!a && !!b && ((a.id && b.id && a.id === b.id) || (a.email && b.email && norm(a.email) === norm(b.email))
    || (a.tiduuid && b.tiduuid && a.tiduuid === b.tiduuid));

  /** Group name as matched: number prefix ("02.", "00_", "2 ", "02-", "4.1-") and extra spaces removed, lower case. */
  const groupKey = (name) => norm(name).replace(/^\d+(?:[.,]\d+)*\s*[.)\-_:]?\s*/, "").trim();
  /** Effective config: defaults + overrides. Old style config.groups {gc: "NAME"} is still accepted. */
  function conf(config) {
    const c = config || {};
    const groupRoles = {};
    for (const [n, r] of Object.entries(Object.assign({}, GROUP_ROLES, c.groupRoles || {}))) groupRoles[groupKey(n)] = r;
    for (const [r, n] of Object.entries(c.groups || {})) groupRoles[groupKey(n)] = r;
    const groupCaps = {};
    for (const [n, caps] of Object.entries(Object.assign({}, GROUP_CAPS, c.groupCaps || {}))) groupCaps[groupKey(n)] = caps;
    return { groupRoles, groupCaps, apps: Object.assign({}, APPS, c.apps || {}), cacheMinutes: c.cacheMinutes || DEFAULTS.cacheMinutes };
  }
  const roleRank = (r) => { const i = ROLE_ORDER.indexOf(r); return i < 0 ? ROLE_ORDER.length : i; };

  /** Core API base for a project location ("europe", "northAmerica", ...). EU when unknown. */
  function coreBase(location) {
    const k = norm(location).replace(/[\s_-]/g, "");
    return `https://${CORE[k] || "app21"}.connect.trimble.com/tc/api/2.0/`;
  }

  /**
   * Role of a user from project data (pure).
   * @param data {user, projectUsers:[{id,email,role,status}], groups:[{name, members:[{id,email}]}]}
   * @returns {role, roles: [every role, in ROLE_ORDER], roleGroups: {role: group name}, reason, group?, caps}
   *   role = roles[0] (display only), "none" when there is no role.
   */
  function resolveRole(data, config) {
    const cfg = conf(config);
    const user = data && data.user;
    if (!user || (!user.id && !user.email)) return { role: "none", roles: [], roleGroups: {}, reason: "no-user", caps: [] };
    const me = ((data && data.projectUsers) || []).find((u) => sameUser(u, user) && String(u.status || "ACTIVE").toUpperCase() !== "REMOVED");
    if (!me) return { role: "none", roles: [], roleGroups: {}, reason: "not-member", caps: [] };
    const caps = new Set();
    const roleGroups = {};   // role -> the first group (in Connect's order) that gives it
    for (const gr of (data && data.groups) || []) {
      const k = groupKey(gr.name);
      if (!(gr.members || []).some((m) => sameUser(m, user))) continue;
      for (const c of cfg.groupCaps[k] || []) caps.add(c);
      const r = cfg.groupRoles[k];
      if (r && !roleGroups[r]) roleGroups[r] = gr.name;
    }
    const capList = [...caps].sort();
    const projectAdmin = norm(me.role) === "admin";
    const roles = sortRoles(Object.keys(roleGroups).concat(projectAdmin ? ["admin"] : []));
    if (!roles.length) return { role: "none", roles: [], roleGroups: {}, reason: "no-group", caps: capList };
    // a Connect project admin is "admin" through the project role, even when also in 00_ADMIN (as before)
    if (projectAdmin) return { role: roles[0], roles, roleGroups, reason: "project-admin", caps: capList };
    return { role: roles[0], roles, roleGroups, reason: "group", group: roleGroups[roles[0]], caps: capList };
  }
  const sortRoles = (list) => [...new Set(list)].sort((a, b) => roleRank(a) - roleRank(b));

  /** The roles of an access / resolveRole result, of a role list, or of one role name. */
  function rolesOf(who) {
    if (!who) return [];
    if (typeof who === "string") return [who];
    if (Array.isArray(who)) return who;
    if (Array.isArray(who.roles) && who.roles.length) return who.roles;
    return who.role ? [who.role] : [];
  }
  /** May this role - or ANY role of an access result / role list (M4) - use an app kind ("execution" | "admin" | ...)?
   *  Unknown app: no. */
  const allows = (app, who, config) => { const list = conf(config).apps[app] || []; return rolesOf(who).some((r) => list.includes(r)); };
  /** Does the access result carry this role (through any of its groups, or the project role)? */
  const hasRole = (access, role) => rolesOf(access).includes(role);

  // ---------- server-side access of a Property Set Library (read only; set it in Connect's "Library access control") ----------
  // Connect writes the policy itself (tested 12.11.2026 on a throwaway library in 1028):
  //   we:libdef:v1   principal {any:["project:P"], notAny:["group:G"]}  -> default access for members (not in G)
  //   we:groupdef:v1 principal {all:["project:P", "group:G"]}            -> access of group G
  //   we:projadm:v1  principal "project:P:ADMIN"                         -> library management, NO pset:PutPSet
  // Write = "pset:PutPSet"; read = "pset:Get*". Project admins can write values only through a group with Edit access.
  /**
   * Who can read / write values under a library policy.
   * @returns {defaultAccess: "edit"|"read"|"none", groups: [{id, access}], adminsWrite: bool, everyoneWrites: bool}
   */
  function describePolicy(policy) {
    const acts = (st) => [].concat((st && st.action) || []);
    const writes = (st) => acts(st).some((a) => a === "*" || /^pset:(PutPSet|\*)$/i.test(a));
    const reads = (st) => acts(st).some((a) => a === "*" || /^pset:(Get(PSet)?\*|GetPSet|\*)$/i.test(a));
    const list = (v) => [].concat(v || []);
    const groupOf = (p) => { const g = list(p).find((x) => /^group:/.test(x)); return g ? g.slice(6) : null; };
    const out = { defaultAccess: "none", groups: [], adminsWrite: false, everyoneWrites: false };
    const level = (st) => (writes(st) ? "edit" : reads(st) ? "read" : "none");
    const better = (a, b) => (["none", "read", "edit"].indexOf(a) >= ["none", "read", "edit"].indexOf(b) ? a : b);
    for (const st of (policy && policy.statements) || []) {
      if (!st || st.effect !== "Allow") continue;
      const p = st.principal;
      if (typeof p === "string") {
        if (p === "*" || /^project:[^:]+$/.test(p)) { out.defaultAccess = better(level(st), out.defaultAccess); if (writes(st)) out.everyoneWrites = true; }
        else if (/^project:[^:]+:ADMIN$/i.test(p)) { if (writes(st)) out.adminsWrite = true; }
        else if (/^group:/.test(p)) out.groups.push({ id: p.slice(6), access: level(st) });
        continue;
      }
      if (p && p.all && groupOf(p.all)) { out.groups.push({ id: groupOf(p.all), access: level(st) }); continue; }
      if (p && p.any) {   // default access for members (possibly except some groups)
        out.defaultAccess = better(level(st), out.defaultAccess);
        if (writes(st) && !list(p.notAny).length) out.everyoneWrites = true;
      }
    }
    return out;
  }

  // ---------- network: timeout, retry, perf (review round 12, M1 / M2 / ?perf=1) ----------
  // The same rules as PsetClient.request in psetapi.js (this file must also work alone; change them together):
  //  - every call is aborted after TIMEOUT_MS (30 s; an upload's PUT: UPLOAD_TIMEOUT_MS, 120 s), the body read included,
  //    and fails with status 0, timeout: true, "Connect не отговаря (време за изчакване) - ...". Never retried (a write
  //    may have gone through); the panels' guards are released by their usual error paths;
  //  - a 429 / 503 is tried again, at most RETRY_TRIES tries in all, after Retry-After (capped at 8 s) or a growing pause
  //    from 500 ms with jitter: every GET, PUT, PATCH and DELETE (same body again: idempotent here). A POST (they all
  //    create something in Core: a folder, an upload, a commit, an object link) only on a 429 that carries Retry-After,
  //    which the service refused without doing it. The error that comes out carries noRetry: true (no second retry in a
  //    caller's mapLimit);
  //  - each try is counted as service "core" by window.ArstenPerf (shared/arsten-perf.js) when loaded and switched on.
  const TIMEOUT_MS = 30000, UPLOAD_TIMEOUT_MS = 120000, RETRY_TRIES = 3;
  const TIMEOUT_TEXT = "Connect не отговаря (време за изчакване)";
  const perfLib = () => {
    const g = typeof globalThis !== "undefined" ? globalThis : typeof self !== "undefined" ? self : {};
    return g.ArstenPerf && typeof g.ArstenPerf.start === "function" ? g.ArstenPerf : null;
  };
  const pause = (ms) => new Promise((r) => setTimeout(r, ms));
  function retryWait(retryAfter, attempt) {
    const ra = Number(retryAfter);
    return retryAfter != null && retryAfter !== "" && isFinite(ra) && ra >= 0 ? Math.min(ra * 1000, 8000)
      : Math.min(500 * 2 ** attempt, 8000) * (0.75 + Math.random() * 0.5);
  }
  function mayRetry(method, status, retryAfter) {
    if (status !== 429 && status !== 503) return false;
    return String(method).toUpperCase() !== "POST" || (status === 429 && retryAfter != null);
  }
  const parseRetryAfter = (res) => {
    let ra = null;
    try { ra = res.headers && typeof res.headers.get === "function" ? res.headers.get("Retry-After") : null; } catch {}
    return ra != null && ra !== "" && isFinite(Number(ra)) ? Number(ra) : null;
  };
  /** fetch + body text within ms; on timeout the request is aborted and an error {status: 0, timeout: true} thrown. */
  async function fetchBody(f, url, init, ms, what) {
    const ac = typeof AbortController === "function" ? new AbortController() : null;
    let timer = null;
    const late = new Promise((resolve, reject) => {
      timer = setTimeout(() => {
        reject(Object.assign(new Error(`${TIMEOUT_TEXT} – ${what}`), { status: 0, timeout: true }));
        try { if (ac) ac.abort(); } catch {}
      }, ms);
    });
    try {
      return await Promise.race([(async () => {
        const res = await f(url, ac ? Object.assign({}, init, { signal: ac.signal }) : init);
        const text = typeof res.text === "function" ? await res.text()
          : typeof res.json === "function" ? JSON.stringify(await res.json()) : "";
        return { res, text };
      })(), late]);
    } finally { clearTimeout(timer); }
  }
  /** One call with timeout, 429 / 503 retry and perf. o: {path (for perf), what (for messages), ms?, tries?, sleep?}.
   *  Returns {res, text}; for a 429 / 503 left after the retries also {busy: true, retryAfter, tries}. */
  async function send(f, url, init, o) {
    const method = (init && init.method) || "GET";
    for (let tries = 1; ; tries++) {
      const p = perfLib(), h = p ? p.start("core", method, o.path) : null;
      let got;
      try { got = await fetchBody(f, url, init, o.ms || TIMEOUT_MS, o.what); }
      catch (e) { if (h) p.end(h, e && e.timeout ? "timeout" : 0); throw e; }
      if (h) p.end(h, got.res.status);
      const st = got.res.status;
      if (st !== 429 && st !== 503) return got;
      const ra = parseRetryAfter(got.res);
      if (tries < (o.tries || RETRY_TRIES) && mayRetry(method, st, ra)) {
        if (p && p.retry) p.retry("core", method, o.path);
        await (o.sleep || pause)(retryWait(ra, tries - 1));
        continue;
      }
      return Object.assign(got, { busy: true, retryAfter: ra, tries });
    }
  }
  /** The error of a failed Core call: status, and for a 429 / 503 after the retries noRetry, retryAfter, tries. */
  function failure(message, got) {
    const e = new Error(message);
    e.status = got.res.status;
    if (got.busy) { e.noRetry = true; e.retryAfter = got.retryAfter; e.tries = got.tries; }
    return e;
  }

  /** opts (tests): {timeoutMs, tries, sleep} */
  async function coreGet(base, path, getToken, fetchImpl, opts) {
    const f = fetchImpl || ((...a) => fetch(...a));
    const o = opts || {};
    const what = `Core API GET ${path.split("?")[0]}`;
    // 401: refresh the token and retry. Right after an extension is installed/allowed the first token can be refused
    // for a moment, so the last tries wait a little (seen live 12.11.2026).
    for (let attempt = 0; attempt < 4; attempt++) {
      const token = await getToken(attempt > 0);
      const got = await send(f, base + path, { headers: { Authorization: "Bearer " + token, Range: "items=0-999" } },
        { path, what, ms: o.timeoutMs, tries: o.tries, sleep: o.sleep });
      const res = got.res;
      if (res.status === 401 && attempt < 3) { if (attempt > 0 && !fetchImpl) await new Promise((r) => setTimeout(r, 1500 * attempt)); continue; }
      if (!res.ok) throw failure(`Core API ${path.split("?")[0]}: ${res.status}`, got);
      return got.text ? JSON.parse(got.text) : null;
    }
  }

  /** Project users and the two groups (with members) from the Core API. */
  async function loadProjectAccess({ projectId, location, getToken, config, fetchImpl }) {
    const cfg = conf(config);
    const base = coreBase(location);
    // Users and groups at the same time, then the mapped groups' members 4 at a time (speed audit item 8: 2 + G calls
    // in series before). Same result and order; any failed call fails the whole read, as before.
    const [projectUsers, allGroups] = await Promise.all([
      coreGet(base, `projects/${encodeURIComponent(projectId)}/users`, getToken, fetchImpl),
      coreGet(base, `groups?projectId=${encodeURIComponent(projectId)}`, getToken, fetchImpl),
    ]);
    const mapped = (allGroups || []).filter((gr) => cfg.groupRoles[groupKey(gr.name)]);   // only the mapped groups are read
    const members = await mapLimit(mapped, MEMBER_READS, (gr) => coreGet(base, `groups/${encodeURIComponent(gr.id)}/users`, getToken, fetchImpl));
    const groups = mapped.map((gr, i) => ({ id: gr.id, name: gr.name, members: members[i] || [] }));
    return { projectUsers: projectUsers || [], groups, groupsFound: groups.map((g) => g.name) };
  }
  const MEMBER_READS = 4;
  /** fn over items, at most `limit` at a time; results in input order; the first error rejects (no new calls start). */
  async function mapLimit(items, limit, fn) {
    const out = new Array(items.length);
    let next = 0, failed = false;
    const worker = async () => {
      while (!failed && next < items.length) {
        const k = next++;
        try { out[k] = await fn(items[k], k); } catch (e) { failed = true; throw e; }
      }
    };
    await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), items.length) }, worker));
    return out;
  }

  const memo = new Map();
  /**
   * Access of the current user for an app kind. Fail closed: any error -> allowed false with the reason.
   * @returns {allowed, role, reason, user, groupsFound, error?}
   */
  async function check({ api, getToken, app = "execution", config, fetchImpl, storage }) {
    const cfg = conf(config);
    let user = null, project = null;
    try {
      project = await api.project.getProject();
      user = await api.user.getUser();
      if (!project || !project.id || !user) throw new Error("no project or user from Trimble Connect");
      // v3 (15.11.2026): 02.1-EXECUTION PROJECT MANAGER + "stages" cap. v4 (17.11.2026): roles union + "write" cap.
      // The key changes whenever the group mapping does, so an older copy of this file in another panel (same origin,
      // same sessionStorage) can never poison the cache.
      const key = `arsten.access.v4.${project.id}.${user.id || user.email}`;
      const st = storage === undefined ? (typeof sessionStorage !== "undefined" ? sessionStorage : null) : storage;
      let res = memo.get(key);
      if (!res && st) {
        try {
          const c = JSON.parse(st.getItem(key) || "null");
          // only a granted role is cached: someone just added to a group must not wait 10 minutes (week 1, A21)
          if (c && c.res && Array.isArray(c.res.caps) && Array.isArray(c.res.roles) && c.res.roles.length && c.res.role !== "none"
            && Date.now() - c.at < cfg.cacheMinutes * 60000) res = c.res;
        } catch {}
      }
      if (!res) {
        const data = await loadProjectAccess({ projectId: project.id, location: project.location, getToken, config: cfg, fetchImpl });
        const r = resolveRole({ user, projectUsers: data.projectUsers, groups: data.groups }, config);
        res = { role: r.role, roles: r.roles || [], roleGroups: r.roleGroups || {}, reason: r.reason, group: r.group || null, caps: r.caps || [], groupsFound: data.groupsFound };
        if (res.role !== "none") {
          memo.set(key, res);
          if (st) { try { st.setItem(key, JSON.stringify({ at: Date.now(), res })); } catch {} }
        }
      }
      const out = Object.assign({ allowed: allows(app, res, config), user, project, app, needs: (cfg.apps[app] || []).slice() }, res);
      // the role shown in THIS app: the first of the user's roles that it allows (display; rights come from roles + caps)
      const appRole = (res.roles || []).find((r) => (cfg.apps[app] || []).includes(r));
      if (appRole && appRole !== res.role) { out.role = appRole; out.group = (res.roleGroups || {})[appRole] || null; }
      return out;
    } catch (e) {
      return { allowed: false, role: "unknown", reason: "error", error: (e && e.message) || String(e), user, project };
    }
  }

  /** Every project member with the role they resolve to (for the admin view; names only). */
  function classifyMembers(data, config) {
    return (data.projectUsers || []).filter((u) => String(u.status || "ACTIVE").toUpperCase() !== "REMOVED").map((u) => {
      const r = resolveRole({ user: u, projectUsers: data.projectUsers, groups: data.groups }, config);
      return { name: [u.firstName, u.lastName].filter(Boolean).join(" ") || "(no name)", role: r.role, roles: r.roles || [], group: r.group || null };
    });
  }

  // ---------- UI ----------
  const ROLE_NAMES = {
    bg: { admin: "администратор", gc: "главен изпълнител", client: "клиент", subcontractor: "подизпълнител", designer: "проектант",
      fabricator: "производител", viewer: "наблюдател", none: "без роля" },
    en: { admin: "admin", gc: "general contractor", client: "client", subcontractor: "subcontractor", designer: "designer",
      fabricator: "fabricator", viewer: "viewer", none: "no role" },
  };
  const TEXT = {
    bg: { title: "Нямате достъп", ask: "Обърнете се към администратора на проекта.", error: "Правата не можаха да бъдат проверени",
      notMember: "Не сте член на проекта.", yourRole: "Вашата роля", noGroup: "не сте в нито една група на проекта, която дава роля",
      viaGroup: "от група", needs: "Този инструмент е за", retry: "Провери отново",
      wait: "Ако току-що сте добавени в група, Connect може да има нужда от няколко минути." },
    en: { title: "No access", ask: "Ask the project admin.", error: "Your access could not be checked",
      notMember: "You are not a project member.", yourRole: "Your role", noGroup: "you are in no project group that gives a role",
      viaGroup: "from group", needs: "This tool is for", retry: "Check again",
      wait: "If you were just added to a group, Connect may need a few minutes." },
  };
  /** Why access was refused, in plain words: the user's role (and its group) and which roles open this tool (week 1, A20). */
  function deniedReason(lang, access) {
    const L = lang === "en" ? "en" : "bg", t = TEXT[L], names = ROLE_NAMES[L];
    const a = access || {};
    if (a.role === "unknown") return [`${t.error}${a.error ? ": " + a.error : ""}.`];
    if (a.reason === "not-member") return [t.notMember];
    const lines = [];
    lines.push(a.role && a.role !== "none" ? `${t.yourRole}: ${names[a.role] || a.role}${a.group ? ` (${t.viaGroup} „${a.group}“)` : ""}.`
      : `${t.yourRole}: ${names.none} – ${t.noGroup}.`);
    if (a.needs && a.needs.length) lines.push(`${t.needs}: ${a.needs.map((r) => names[r] || r).join(", ")}.`);
    if (a.role === "none") lines.push(t.wait);
    return lines;
  }
  /** Replace the panel with a short no-access message (no project data) and a "check again" button. */
  function renderDenied(container, lang, access) {
    const t = TEXT[lang === "en" ? "en" : "bg"];
    const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
    container.innerHTML = `<div style="padding:16px;font:13px/1.45 Ubuntu,'Segoe UI',system-ui,sans-serif;color:#1f1f1f">
      <div style="font-size:15px;font-weight:600;margin-bottom:6px">${esc(t.title)} / ${esc(TEXT[lang === "en" ? "bg" : "en"].title)}</div>
      <div>${esc(t.ask)}</div>${deniedReason(lang, access).map((l) => `<div style="margin-top:6px;font-size:12px;color:#6b6b6b">${esc(l)}</div>`).join("")}
      <button type="button" data-arsten-retry style="margin-top:12px;font:inherit;font-size:12px;padding:4px 10px;border:1px solid #1f1f1f;background:#1f1f1f;color:#fff;cursor:pointer;border-radius:0">${esc(t.retry)}</button></div>`;
    const b = typeof container.querySelector === "function" ? container.querySelector("[data-arsten-retry]") : null;
    if (b) b.onclick = () => {
      memo.clear();
      try { for (let i = sessionStorage.length - 1; i >= 0; i--) { const k = sessionStorage.key(i); if (k && k.startsWith("arsten.access.")) sessionStorage.removeItem(k); } } catch {}
      try { location.reload(); } catch {}
    };
  }

  /** Token for extensions that have none: getToken(refresh) + onEvent to feed "extension.accessToken" events. */
  // Round 12 L6: a waiter is registered BEFORE requestPermission (so a token event that comes during the call is not
  // missed) and removed again - its 60 s timer cleared - when the call returns the token itself, is denied or fails, or
  // when it times out. So the list holds only the calls really waiting, and no unobserved promise rejects a minute later.
  // opts (tests): {timeoutMs}.
  function tokenGetter(api, opts) {
    const waitMs = (opts && opts.timeoutMs) || 60000;
    let token = null, waiters = [];
    const settle = (w) => { clearTimeout(w.timer); waiters = waiters.filter((x) => x !== w); };
    const onEvent = (event, data) => {
      if (event === "extension.accessToken" && data) {
        token = data;
        const list = waiters; waiters = [];
        for (const w of list) { clearTimeout(w.timer); w.resolve(data); }
      }
    };
    const getToken = async (refresh) => {
      if (token && !refresh) return token;
      const w = {};
      const p = new Promise((resolve, reject) => {
        w.resolve = resolve;
        w.timer = setTimeout(() => { settle(w); reject(new Error("No access token from Trimble Connect")); }, waitMs);
      });
      p.catch(() => {});   // only an error for the caller that awaits it (below), never an unhandled rejection
      waiters.push(w);
      let r;
      try { r = await api.extension.requestPermission("accesstoken"); }
      catch (e) { settle(w); throw e; }
      if (r === "denied") { settle(w); throw new Error("Access to Trimble Connect data was denied for this extension"); }
      if (r && r !== "pending" && r !== "granted") { settle(w); token = r; return r; }
      return p;
    };
    return { getToken, onEvent, _waiting: () => waiters.length };
  }

  /** Does an access result carry a capability ("approve")? */
  const can = (access, cap) => !!(access && (access.caps || []).includes(cap));
  /** May write statuses in the work panels (round 11, M3): admin or GC side, and an admin only through a group with
   *  Edit ("write": 00_ADMIN, 02, 02.1). A Connect project ADMIN outside them is read-only, as pset-api treats them. */
  function canWrite(access) {
    const admin = hasRole(access, "admin"), gc = hasRole(access, "gc");
    if (!admin && !gc) return false;
    return can(access, "write") || !admin;
  }
  /** Site or office view (week 3 A8, round 11 M5), the same rule in every panel: "office" = admin, the PM side (the
   *  "stages" cap), designer or fabricator (any of the user's roles); "site" = everyone else, and an unknown access. */
  function side(access) {
    if (!access) return "site";
    return ["admin", "designer", "fabricator"].some((r) => hasRole(access, r)) || can(access, "stages") ? "office" : "site";
  }

  return { DEFAULTS, APPS, GROUP_ROLES, GROUP_CAPS, ROLE_ORDER, can, hasRole, rolesOf, canWrite, side, groupKey, coreBase, resolveRole, allows, classifyMembers, check, loadProjectAccess, describePolicy, renderDenied, deniedReason, tokenGetter, coreGet, TIMEOUT_MS, TIMEOUT_TEXT, _memo: memo };
});
