// Arsten access control for Trimble Connect extensions (role-based, fail closed).
//
// Roles, from the Connect project (ALL configuration is in GROUP_ROLES and APPS below):
//   admin  - project role ADMIN                          -> everything
//   gc     - group "GENERAL CONTRACTOR" (1028: "02.GENERAL CONTRACTOR") -> execution extensions
//   client - group "CLIENT" ("01.CLIENT")                -> "Project status" (client viewer)
//   subcontractor / designer / viewer - groups "03.SUBCONTRACTORS" / "04.DESIGNERS" / "05.VIEWERS" -> nothing yet
//   none   - anyone else, or the role cannot be determined -> no access
// Group names are matched without a leading number prefix ("02." / "2 " / "02-"), case- and space-insensitively.
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
    "GENERAL CONTRACTOR": "gc",
    "CLIENT": "client",
    "SUBCONTRACTORS": "subcontractor",
    "DESIGNERS": "designer",
    "VIEWERS": "viewer",
  };
  /** Which roles may use which kind of extension. Roles not listed anywhere have no access. */
  const APPS = { execution: ["admin", "gc"], admin: ["admin"], projectStatus: ["admin", "client"] };
  /** When someone is in several groups, the first role in this order wins. */
  const ROLE_ORDER = ["admin", "gc", "client", "subcontractor", "designer", "viewer"];
  const DEFAULTS = { groupRoles: GROUP_ROLES, apps: APPS, cacheMinutes: 10 };
  const CORE = { northamerica: "app", europe: "app21", unitedkingdom: "app22", asia: "app31", australia: "app32" };

  const norm = (s) => String(s == null ? "" : s).normalize("NFC").replace(/\s+/g, " ").trim().toLowerCase();
  const sameUser = (a, b) => !!a && !!b && ((a.id && b.id && a.id === b.id) || (a.email && b.email && norm(a.email) === norm(b.email))
    || (a.tiduuid && b.tiduuid && a.tiduuid === b.tiduuid));

  /** Group name as matched: number prefix ("02.", "2 ", "02-") and extra spaces removed, lower case. */
  const groupKey = (name) => norm(name).replace(/^\d+\s*[.)\-_:]?\s*/, "").trim();
  /** Effective config: defaults + overrides. Old style config.groups {gc: "NAME"} is still accepted. */
  function conf(config) {
    const c = config || {};
    const groupRoles = {};
    for (const [n, r] of Object.entries(Object.assign({}, GROUP_ROLES, c.groupRoles || {}))) groupRoles[groupKey(n)] = r;
    for (const [r, n] of Object.entries(c.groups || {})) groupRoles[groupKey(n)] = r;
    return { groupRoles, apps: Object.assign({}, APPS, c.apps || {}), cacheMinutes: c.cacheMinutes || DEFAULTS.cacheMinutes };
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
   * @returns {role: "admin"|"gc"|"client"|"none", reason}
   */
  function resolveRole(data, config) {
    const cfg = conf(config);
    const user = data && data.user;
    if (!user || (!user.id && !user.email)) return { role: "none", reason: "no-user" };
    const me = ((data && data.projectUsers) || []).find((u) => sameUser(u, user) && String(u.status || "ACTIVE").toUpperCase() !== "REMOVED");
    if (!me) return { role: "none", reason: "not-member" };
    if (norm(me.role) === "admin") return { role: "admin", reason: "project-admin" };
    let best = null;
    for (const gr of (data && data.groups) || []) {
      const r = cfg.groupRoles[groupKey(gr.name)];
      if (!r || !(gr.members || []).some((m) => sameUser(m, user))) continue;
      if (!best || roleRank(r) < roleRank(best.role)) best = { role: r, reason: "group", group: gr.name };
    }
    return best || { role: "none", reason: "no-group" };
  }

  /** Is a role allowed to use an app kind ("execution" | "admin" | "projectStatus")? Unknown app: no. */
  const allows = (app, role, config) => (conf(config).apps[app] || []).includes(role);

  // ---------- server-side write protection (Property Set Library policy) ----------
  const WRITE_ID = "ArstenWriters";
  /**
   * Library policy where everyone in the project can read, and only the given Trimble ID subs can write psets.
   * Keeps the other statements of the current policy (e.g. Connect's own app access), replaces any statement that
   * lets everyone write (pset:PutPSet with principal "*"), and adds one statement for the writers.
   * @param current the library's current policy ({version, statements}) or null; writers: [tiduuid]
   */
  function writersPolicy(current, writers) {
    const subs = [...new Set((writers || []).filter(Boolean))].sort();
    const statements = [];
    for (const st of (current && current.statements) || []) {
      if (st && typeof st.id === "string" && st.id.startsWith(WRITE_ID)) continue;
      const actions = [].concat(st && st.action || []);
      const writes = actions.some((a) => /^pset:(PutPSet|\*)$/i.test(a) || a === "*");
      if (st && st.effect === "Allow" && st.principal === "*" && writes) {
        const rest = actions.filter((a) => !/^pset:(PutPSet|\*)$/i.test(a) && a !== "*");
        if (rest.length) statements.push(Object.assign({}, st, { action: rest }));   // keep the read part
        continue;
      }
      statements.push(st);
    }
    if (!statements.some((st) => st && st.effect === "Allow" && st.principal === "*" && [].concat(st.action || []).some((a) => /^pset:GetPSet/i.test(a)))) {
      statements.push({ id: "ArstenReaders", effect: "Allow", principal: "*", action: ["pset:GetPSet*", "pset:ListPSets", "pset:Subscribe"], resource: ["*"] });
    }
    // one statement per writer, principal "sub:<Trimble ID>" exactly as Connect's own policies use it
    subs.forEach((s, i) => statements.push({ id: `${WRITE_ID}-${i + 1}`, effect: "Allow", principal: "sub:" + s, action: ["pset:PutPSet", "pset:GetPSet*"], resource: ["*"] }));
    return { version: (current && current.version) || "2020-04-06", statements };
  }
  /** Who can write psets under a policy: "everyone", ["sub", ...] or "nobody" (best effort, for display). */
  function policyWriters(policy) {
    const subs = [];
    for (const st of (policy && policy.statements) || []) {
      if (!st || st.effect !== "Allow") continue;
      const actions = [].concat(st.action || []);
      if (!actions.some((a) => /^pset:(PutPSet|\*)$/i.test(a) || a === "*")) continue;
      const ps = [].concat(st.principal || []);
      if (ps.includes("*")) return "everyone";
      for (const p of ps) if (/^sub:/.test(p)) subs.push(p.slice(4));
    }
    return subs.length ? subs : "nobody";
  }

  // ---------- network ----------
  async function coreGet(base, path, getToken, fetchImpl) {
    const f = fetchImpl || fetch;
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = await getToken(attempt > 0);
      const res = await f(base + path, { headers: { Authorization: "Bearer " + token, Range: "items=0-999" } });
      if (res.status === 401 && attempt === 0) continue;
      if (!res.ok) throw new Error(`Core API ${path.split("?")[0]}: ${res.status}`);
      return res.json();
    }
  }

  /** Project users and the two groups (with members) from the Core API. */
  async function loadProjectAccess({ projectId, location, getToken, config, fetchImpl }) {
    const cfg = conf(config);
    const base = coreBase(location);
    const projectUsers = await coreGet(base, `projects/${encodeURIComponent(projectId)}/users`, getToken, fetchImpl);
    const allGroups = await coreGet(base, `groups?projectId=${encodeURIComponent(projectId)}`, getToken, fetchImpl);
    const groups = [];
    for (const gr of allGroups || []) {
      if (!cfg.groupRoles[groupKey(gr.name)]) continue;   // only the mapped groups are read
      const members = await coreGet(base, `groups/${encodeURIComponent(gr.id)}/users`, getToken, fetchImpl);
      groups.push({ id: gr.id, name: gr.name, members: members || [] });
    }
    return { projectUsers: projectUsers || [], groups, groupsFound: groups.map((g) => g.name) };
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
      const key = `arsten.access.${project.id}.${user.id || user.email}`;
      const st = storage === undefined ? (typeof sessionStorage !== "undefined" ? sessionStorage : null) : storage;
      let res = memo.get(key);
      if (!res && st) { try { const c = JSON.parse(st.getItem(key) || "null"); if (c && Date.now() - c.at < cfg.cacheMinutes * 60000) res = c.res; } catch {} }
      if (!res) {
        const data = await loadProjectAccess({ projectId: project.id, location: project.location, getToken, config: cfg, fetchImpl });
        const r = resolveRole({ user, projectUsers: data.projectUsers, groups: data.groups }, config);
        res = { role: r.role, reason: r.reason, group: r.group || null, groupsFound: data.groupsFound };
        memo.set(key, res);
        if (st) { try { st.setItem(key, JSON.stringify({ at: Date.now(), res })); } catch {} }
      }
      return Object.assign({ allowed: allows(app, res.role, config), user, project }, res);
    } catch (e) {
      return { allowed: false, role: "unknown", reason: "error", error: (e && e.message) || String(e), user, project };
    }
  }

  /** Writers for the Pour status library policy: Trimble ID subs of project admins and GC group members. */
  async function writerSubs({ projectId, location, getToken, config, fetchImpl }) {
    const data = await loadProjectAccess({ projectId, location, getToken, config, fetchImpl });
    const cfg = conf(config);
    const writeRoles = cfg.apps.execution.filter((r) => r !== "admin");   // whoever may use the execution extensions
    const admins = data.projectUsers.filter((u) => norm(u.role) === "admin" && String(u.status || "ACTIVE").toUpperCase() !== "REMOVED");
    const gcGroups = data.groups.filter((g) => writeRoles.includes(cfg.groupRoles[groupKey(g.name)]));
    const gc = gcGroups.flatMap((g) => g.members || []);
    const subs = [...admins, ...gc].map((u) => u.tiduuid).filter(Boolean);
    return { subs: [...new Set(subs)], admins: admins.length, gcMembers: new Set(gc.map((u) => u.id || u.email)).size, gcGroupFound: gcGroups.length > 0 };
  }

  /** Every project member with the role they resolve to (for the admin view; names only). */
  function classifyMembers(data, config) {
    return (data.projectUsers || []).filter((u) => String(u.status || "ACTIVE").toUpperCase() !== "REMOVED").map((u) => {
      const r = resolveRole({ user: u, projectUsers: data.projectUsers, groups: data.groups }, config);
      return { name: [u.firstName, u.lastName].filter(Boolean).join(" ") || "(no name)", role: r.role, group: r.group || null };
    });
  }

  // ---------- UI ----------
  const TEXT = {
    bg: { title: "Нямате достъп", ask: "Обърнете се към администратора на проекта.", error: "Правата не можаха да бъдат проверени",
      roles: { client: "Вашата роля: клиент", none: "Не сте в група „GENERAL CONTRACTOR“", "not-member": "Не сте член на проекта" } },
    en: { title: "No access", ask: "Ask the project admin.", error: "Your access could not be checked",
      roles: { client: "Your role: client", none: "You are not in the group \"GENERAL CONTRACTOR\"", "not-member": "You are not a project member" } },
  };
  /** Replace the panel with a short no-access message (no project data). */
  function renderDenied(container, lang, access) {
    const t = TEXT[lang === "en" ? "en" : "bg"];
    const why = access && access.role === "unknown" ? `${t.error}${access.error ? ": " + access.error : ""}.`
      : access && access.reason === "not-member" ? t.roles["not-member"] : access && access.role === "client" ? t.roles.client : t.roles.none;
    const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
    container.innerHTML = `<div style="padding:16px;font:13px/1.45 Ubuntu,'Segoe UI',system-ui,sans-serif;color:#1f1f1f">
      <div style="font-size:15px;font-weight:600;margin-bottom:6px">${esc(t.title)} / ${esc(TEXT[lang === "en" ? "bg" : "en"].title)}</div>
      <div>${esc(t.ask)}</div><div style="margin-top:8px;font-size:12px;color:#6b6b6b">${esc(why)}</div></div>`;
  }

  /** Token for extensions that have none: getToken(refresh) + onEvent to feed "extension.accessToken" events. */
  function tokenGetter(api) {
    let token = null, waiters = [];
    const onEvent = (event, data) => {
      if (event === "extension.accessToken" && data) { token = data; const w = waiters; waiters = []; w.forEach((f) => f(data)); }
    };
    const getToken = async (refresh) => {
      if (token && !refresh) return token;
      const p = new Promise((resolve, reject) => { waiters.push(resolve); setTimeout(() => reject(new Error("No access token from Trimble Connect")), 60000); });
      const r = await api.extension.requestPermission("accesstoken");
      if (r === "denied") throw new Error("Access to Trimble Connect data was denied for this extension");
      if (r && r !== "pending" && r !== "granted") { token = r; return r; }
      return p;
    };
    return { getToken, onEvent };
  }

  return { DEFAULTS, APPS, GROUP_ROLES, ROLE_ORDER, groupKey, coreBase, resolveRole, allows, classifyMembers, check, loadProjectAccess, writerSubs, writersPolicy, policyWriters, renderDenied, tokenGetter, _memo: memo };
});
