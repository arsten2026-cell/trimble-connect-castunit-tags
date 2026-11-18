// Cast unit logic for the Cast unit tags extension: group Tekla cast units (IfcElementAssembly) by model + mark,
// sum concrete volume and rebar, build the rebar table and label text. No Workspace API calls here, so it runs in
// the browser (window.CastUnitLogic) and in Node tests (module.exports). Helpers come from common.js.
(function (root, factory) {
  const C = typeof module === "object" && module.exports ? require("./common.js") : root.PourLogic;
  const lib = factory(C);
  if (typeof module === "object" && module.exports) module.exports = lib;
  else root.CastUnitLogic = lib;
})(typeof self !== "undefined" ? self : this, function (C) {
  "use strict";

  // Cast unit pset (from the firm's MultiplanBulgaria.xml). Missing in exports made without its filter file.
  const CU_PSET = "Cast_Unit/Бетонов_елемент";
  const CU = {
    mark: "Cast_Unit/Марка_Елемент",
    layer: "Layer",
    phase: "Pour_Phase/Такт",
    weight: "Cast_unit_weight/Маса_Елемент",
    rebar: "Rebar_Weight/Тегло_Армировка",
    volume: "Volume_Обем",
    material: "Material/Материал",
  };
  const PART_PSET = "Part/Детайл";
  const PART = { pos: "Pos/Позиция", profile: "Profile/Профил(Сечение)", material: "Material/Материал", volume: "Volume/Обем" };
  const REBAR_PSET = "Rebar/Армировка";
  const num = C.num;
  const str = (v) => (v == null ? "" : String(v).trim());

  /** Mark prefix for tagging by group: "FP12" -> "FP", "W0(?)" -> "W", "LC0(?)" -> "LC"; no mark -> "?". */
  function markPrefix(mark) {
    const m = str(mark).match(/^[^\d(]+/);
    return m ? m[0].trim() : "?";
  }

  /**
   * One row per cast unit instance (identical cast units share a Tekla mark, e.g. four "FP1", but each one is its
   * own row, as the user asked). Units without a mark (cast unit pset missing) are labelled "?".
   * @param units [{modelId, modelName, id, name, cu: {pset map}|null,
   *               parts: [{modelId, id, props: Part pset, bbox}], rebars: [{modelId, id, props: Rebar pset}]}]
   */
  function groupCastUnits(units) {
    const groups = new Map();
    for (const u of units) {
      const mark = str(u.cu && u.cu[CU.mark]);
      // "W0(?)" = not numbered in Tekla: listed in the "Not numbered" section.
      const shared = mark && !C.isUnnumbered(mark);
      const key = u.modelId + "|#" + u.id;
      if (!groups.has(key)) {
        groups.set(key, {
          key, mark, label: mark || "?", numbered: !!shared, prefix: markPrefix(mark),   // false: no mark, or "(?)" (Tekla numbering not up to date)
          name: str(u.name), modelId: u.modelId, modelName: u.modelName || u.modelId,
          instances: [], objects: [], rebars: [], materials: new Set(), positions: new Set(),
          totals: { volume: 0, rebar: 0, psetRebar: null, weight: null },
        });
      }
      const g = groups.get(key);
      g.instances.push(u);
      g.objects.push(...u.parts);          // concrete parts: what tags, select, focus and colour act on
      g.rebars.push(...u.rebars);
      const partVol = u.parts.reduce((n, p) => n + num((p.props || {})[PART.volume]), 0);
      g.totals.volume += u.cu && u.cu[CU.volume] != null ? num(u.cu[CU.volume]) : partVol;
      g.totals.rebar += u.rebars.reduce((n, r) => n + num((r.props || {})["Group_Weight/Тегло_Група"]), 0);
      if (u.cu && u.cu[CU.rebar] != null) g.totals.psetRebar = (g.totals.psetRebar || 0) + num(u.cu[CU.rebar]);
      if (u.cu && u.cu[CU.weight] != null) g.totals.weight = (g.totals.weight || 0) + num(u.cu[CU.weight]);
      const mat = str(u.cu && u.cu[CU.material]);
      if (mat) g.materials.add(mat);
      for (const p of u.parts) {
        const pm = str((p.props || {})[PART.material]);
        if (pm && !mat) g.materials.add(pm);
        const pos = str((p.props || {})[PART.pos]);
        if (pos) g.positions.add(pos.replace(/^Concrete_/i, ""));
      }
    }
    const out = [...groups.values()].map((g) => {
      g.materials = [...g.materials];
      g.positions = [...g.positions].sort(C.naturalCompare);
      return g;
    });
    // numbered cast units first (natural sort by mark); then unnumbered ones ("(?)" or no mark) by name
    out.sort((a, b) => (b.numbered - a.numbered) ||
      (a.numbered ? C.naturalCompare(a.mark, b.mark) : C.naturalCompare(a.name, b.name) || C.naturalCompare(a.mark, b.mark)) ||
      C.naturalCompare(a.positions[0] || "", b.positions[0] || "") || C.naturalCompare(String(a.key), String(b.key)));
    return out;
  }

  /**
   * Filter by mark. Several terms (space or comma separated) are OR-ed; case-insensitive.
   *  - a term ending in a letter matches marks that start with it: "FP" -> FP1 … FP15, FP2(?), not FS1
   *  - a term ending in a digit matches that mark exactly, or its unnumbered form: "FP2" -> FP2, FP2(?); not FP20
   * An empty query matches everything.
   */
  function matchMark(mark, query) {
    const terms = str(query).toUpperCase().split(/[\s,;]+/).filter(Boolean);
    if (!terms.length) return true;
    const m = str(mark).toUpperCase();
    return terms.some((t) => (/\d$/.test(t) ? m === t || m.startsWith(t + "(") : m.startsWith(t)));
  }

  /** Prefix groups for the "tag by group" bar: [{prefix, count}], naturally sorted. */
  function prefixGroups(groups) {
    const m = new Map();
    for (const g of groups) m.set(g.prefix, (m.get(g.prefix) || 0) + 1);
    return [...m].map(([prefix, count]) => ({ prefix, count })).sort((a, b) => C.naturalCompare(a.prefix, b.prefix));
  }

  /** Rebar table of a cast unit group: Tekla's native rebar objects grouped by Pos + Ø, pcs and kg summed. */
  function rebarTable(rebars) {
    const map = new Map();
    for (const r of rebars || []) {
      const p = r.props || {};
      const pos = str(p["Pos/Позиция"]) || "?";
      const size = str(p["Size/Диаметър"]);
      const k = pos + "|" + size;
      if (!map.has(k)) map.set(k, { pos, size, qty: 0, weight: 0, ids: [] });
      const e = map.get(k);
      e.qty += num(p["Qty_in_Group/Брой_в_Група"]) || 1;
      e.weight += num(p["Group_Weight/Тегло_Група"]);
      e.ids.push(r);
    }
    const rows = [...map.values()].sort((a, b) => C.naturalCompare(a.pos, b.pos) || C.naturalCompare(a.size, b.size));
    return { rows, qty: rows.reduce((n, r) => n + r.qty, 0), weight: rows.reduce((n, r) => n + r.weight, 0) };
  }

  const FIELDS = [
    { id: "mark", label: "Mark · марка", def: true },
    { id: "name", label: "Name · наименование", def: true },
    { id: "volume", label: "Concrete volume · бетон (m³)", def: true },
    { id: "rebar", label: "Rebar · арм. (kg)", def: true },
    { id: "material", label: "Concrete grade · клас", def: true },
  ];
  const fmt = (v, d) => String(Number(v.toFixed(d)));
  const nameHalf = (name, lang) => { const [en, bg] = String(name).split("/"); return ((lang === "bg" ? bg : en) || en || name).trim(); };

  /** Label text, one field per line by default ("lines") or comma-separated ("single"); Bulgarian by default. */
  function labelText(g, fields, opts) {
    const o = opts || {};
    const lang = o.lang || "bg";
    const bg = lang === "bg";
    const on = new Set(fields || FIELDS.filter((f) => f.def).map((f) => f.id));
    const parts = [];
    for (const f of FIELDS) {
      if (!on.has(f.id)) continue;
      if (f.id === "mark") parts.push(g.label);
      if (f.id === "name" && g.name) parts.push(nameHalf(g.name, lang));
      if (f.id === "volume") parts.push(bg ? `бетон - ${C.fmtVolume(g.totals.volume, "bg")} м³` : `${C.fmtVolume(g.totals.volume)} m³`);
      if (f.id === "rebar" && g.totals.rebar > 0) parts.push(bg ? `арм. ${fmt(g.totals.rebar, 0)}кг` : `rebar ${fmt(g.totals.rebar, 0)} kg`);
      if (f.id === "material" && g.materials.length) parts.push(bg ? `клас - ${g.materials.join(", ")}` : g.materials.join("+"));
    }
    return parts.join((o.layout || "lines") === "single" ? ", " : "\n");
  }

  /**
   * One setObjectState call per colour instead of one per group (speed audit item 4; the palette has a fixed number of
   * colours). entries [{objects, colour}] in the order the calls used to be made; an object listed in more than one
   * entry keeps the colour of its last one, as with the calls in series - so the model looks exactly the same.
   * Returns [{colour, objects}] (objects in their original order, each once) in the order the colours first appear.
   */
  function colourBatches(entries) {
    const list = entries || [];
    const ck = (c) => (typeof c === "string" ? c.toLowerCase() : JSON.stringify(c));
    const last = new Map();   // "modelId:id" -> index of the last entry listing the object
    list.forEach((e, i) => { for (const o of (e && e.objects) || []) last.set(o.modelId + ":" + o.id, i); });
    const out = new Map(), done = new Set();
    list.forEach((e, i) => {
      for (const o of (e && e.objects) || []) {
        const k = o.modelId + ":" + o.id;
        if (last.get(k) !== i || done.has(k)) continue;
        done.add(k);
        const c = ck(e.colour);
        if (!out.has(c)) out.set(c, { colour: e.colour, objects: [] });
        out.get(c).objects.push(o);
      }
    });
    return [...out.values()];
  }

  /** Run async jobs a few at a time (results in the order of items). */
  async function pool(items, n, fn) {
    const out = new Array(items.length);
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
      while (next < items.length) { const k = next++; out[k] = await fn(items[k], k); }
    }));
    return out;
  }

  /**
   * The cast unit (ElementAssembly) parents of the concrete parts, when getObjects lists no assemblies (sweep 18.11.2026).
   * It was one getParents([id]) call per part: 5 000 parts = 5 000 viewer round trips, 30+ s on a phone. Now the parts
   * go in chunks (default 200 ids, 4 at a time) and every returned parent is kept; only the set of parents is needed,
   * the part -> parent mapping comes from getChildren of each parent. Whatever is not covered by the children of the
   * found parents (a chunk call that threw, or a viewer that answers a many-id call with the first id's parent only)
   * is asked again one id at a time, as before - so the result is never worse than the old per-part path.
   * No Workspace API here: getParents(ids) -> [{id, name}], getChildren(parentId) -> [child ids] are passed in.
   * Returns { parents: Map id -> {id, name}, kids: Map parentId -> [child ids], noParent, calls }.
   */
  async function findParents(partIds, getParents, getChildren, opts) {
    const o = opts || {};
    const chunk = o.chunk || 200, poolN = o.pool || 4, poolOne = o.poolOne || 8;
    const parents = new Map(), kids = new Map();
    // failed: viewer reads that threw and were not covered by another pass, so the caller can say "press Reload"
    // instead of blaming the export (sweep 18.11.2026)
    let noParent = 0, calls = 0, failed = 0;
    const add = (p) => { if (p && p.id != null && !parents.has(p.id)) parents.set(p.id, { id: p.id, name: p.name || "" }); };
    const chunks = [];
    for (let i = 0; i < partIds.length; i += chunk) chunks.push(partIds.slice(i, i + chunk));
    await pool(chunks, poolN, async (ids) => {
      calls++;
      try { for (const p of (await getParents(ids)) || []) add(p); } catch { /* covered by the per-id pass below */ }
    });
    const covered = new Set();
    const readKids = async (pid) => {
      if (kids.has(pid)) return;
      let list = [];
      try { list = (await getChildren(pid)) || []; } catch { failed++; }
      kids.set(pid, list);
      for (const c of list) covered.add(c);
    };
    await pool([...parents.keys()], poolOne, readKids);
    const rest = partIds.filter((id) => !covered.has(id));
    // each worker takes its own run of neighbouring ids, in series: the parts of one cast unit are usually listed
    // together, so once a worker found their parent the next ones are covered and not asked (8 workers on adjacent
    // ids would all ask about the same cast unit at once)
    const runs = [];
    const step = Math.ceil(rest.length / poolOne) || 1;
    for (let i = 0; i < rest.length; i += step) runs.push(rest.slice(i, i + step));
    await pool(runs, poolOne, async (run) => {
      for (const id of run) {
        if (covered.has(id)) continue;   // a parent found meanwhile in this pass already holds it
        calls++;
        try {
          const ps = (await getParents([id])) || [];
          if (!ps[0]) { noParent++; continue; }
          add(ps[0]);
          await readKids(ps[0].id);
        } catch { noParent++; failed++; }
      }
    });
    return { parents, kids, noParent, calls, failed };
  }

  /** Key of the loaded models, as Монолитен бетон / Статус (U.modelSetKey): "id@versionId" sorted; null when it cannot be
   *  compared safely (nothing loaded, or a model without id / versionId: then the panel always reads again). */
  function modelSetKey(specs) {
    if (!Array.isArray(specs) || !specs.length) return null;
    const out = new Set();
    for (const m of specs) {
      if (!m || m.id == null || m.id === "" || m.versionId == null || m.versionId === "") return null;
      out.add(String(m.id) + "@" + String(m.versionId));
    }
    return [...out].sort().join("|");
  }

  /** sessionStorage key of "this model version has no cast units". Not the pour key of Монолитен бетон (U.noPourKey):
   *  a model without pour objects can still hold cast units, and the other way round. */
  const noCastUnitKey = (projectId, modelId, ver) => `arsten.castUnitScan.v1.${projectId || "?"}.${modelId}@${ver}`;
  /**
   * Every loaded model through scanOne(m) -> {units, failed, noParent}, `limit` models at a time (default 2), results in
   * model order (sweep 18.11.2026). It was one model after the other, so the structure waited for a full property read
   * of the architecture and MEP models loaded beside it. As Монолитен бетон's scanPours, a model version remembered
   * without cast units (o.cache, by o.versions modelId -> versionId and the object count) is skipped, and one read
   * without any - and without a failed read, which may be the reason none were found - is remembered.
   * o: {limit, versions: Map, cache: {get, set, drop}, projectId}. Returns {results, skipped}.
   */
  async function scanModels(modelObjs, scanOne, o) {
    o = o || {};
    let skipped = 0;
    const empty = () => ({ units: [], failed: 0, noParent: 0 });
    const results = await pool(modelObjs || [], o.limit || 2, async (m) => {
      const n = (m.objects || []).length;
      if (!n) return empty();
      const ver = o.versions && o.versions.get(m.modelId);
      const key = ver && o.cache ? noCastUnitKey(o.projectId, m.modelId, ver) : null;
      if (key) { const c = o.cache.get(key); if (c && c.hasUnits === false && c.n === n) { skipped++; return empty(); } }
      const r = await scanOne(m);
      if (key) { if (r.units.length) o.cache.drop(key); else if (!r.failed) o.cache.set(key, { n, hasUnits: false }); }
      return r;
    });
    return { results, skipped };
  }

  return { CU_PSET, CU, PART_PSET, PART, REBAR_PSET, FIELDS, markPrefix, matchMark, groupCastUnits, prefixGroups, rebarTable, labelText, colourBatches,
    pool, findParents, modelSetKey, noCastUnitKey, scanModels };
});
