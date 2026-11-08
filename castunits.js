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
      if (f.id === "volume") parts.push(bg ? `бетон - ${C.fmtVolume(g.totals.volume)} м³` : `${C.fmtVolume(g.totals.volume)} m³`);
      if (f.id === "rebar" && g.totals.rebar > 0) parts.push(bg ? `арм. ${fmt(g.totals.rebar, 0)}кг` : `rebar ${fmt(g.totals.rebar, 0)} kg`);
      if (f.id === "material" && g.materials.length) parts.push(bg ? `клас - ${g.materials.join(", ")}` : g.materials.join("+"));
    }
    return parts.join((o.layout || "lines") === "single" ? ", " : "\n");
  }

  return { CU_PSET, CU, PART_PSET, PART, REBAR_PSET, FIELDS, markPrefix, matchMark, groupCastUnits, prefixGroups, rebarTable, labelText };
});
