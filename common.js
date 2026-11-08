// Shared helpers copied from viewer-pour-tags/pours.js (Pour tags stays independent): property-set reading,
// natural sort, tag placement on bounding boxes, palette, multi-model de-duplication. Exposed as window.PourLogic
// in the browser and module.exports in Node.
(function (root, factory) {
  const lib = factory();
  if (typeof module === "object" && module.exports) module.exports = lib;
  else root.PourLogic = lib;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const PSET = "Pour/Такт";
  // Property names exactly as the Arsten_PourExport macro writes them (MultiplanBulgaria.xml).
  const P = {
    number: "Pour_Number/Номер_Такт",
    type: "Pour_Type/Тип_Такт",
    phase: "Pour_Phase/Такт",
    material: "Material/Материал",
    volume: "Concrete_Volume/Обем_Бетон",
    rebar: "Rebar_Weight/Тегло_Армировка",
    fwSides: "Formwork_Sides/Кофраж_Страни",
    fwBottom: "Formwork_Bottom/Кофраж_Дъно",
    embeds: "Embedded_Parts/Закладни_Части",
    parts: "Parts/Елементи",
    rebarList: "Rebar_List/Армировка_Списък",   // optional (newer Arsten_PourExport): "2.1 Ø14 x90 166.6kg; ..."   // optional (newer Arsten_PourExport): "<name> <profile> [<pos>] xN; ..."
    date: "Pour_Data_Date/Дата_Данни",
  };

  const norm = (s) => String(s == null ? "" : s).normalize("NFC").trim().toLowerCase();

  /** Find the pour property set in a Connect ObjectProperties record (or a fixture's psets map).
   *  Returns a plain {propertyName: value} map, or null when the object has no pour data. */
  function readPourPset(obj) {
    if (!obj) return null;
    if (Array.isArray(obj.properties)) {
      const want = norm(PSET);
      const set = obj.properties.find((s) => norm(s && s.name) === want) ||
        obj.properties.find((s) => s && Array.isArray(s.properties) &&
          s.properties.some((p) => norm(p && p.name) === norm(P.number)));
      if (!set) return null;
      const out = {};
      for (const p of set.properties || []) if (p && p.name != null) out[String(p.name).normalize("NFC")] = p.value;
      return out;
    }
    if (obj.psets) {
      const key = Object.keys(obj.psets).find((k) => norm(k) === norm(PSET));
      return key ? obj.psets[key] : null;
    }
    return null;
  }

  /** Any property set by name from a Connect ObjectProperties record, as {propertyName: value}; null if absent. */
  function readPset(obj, name) {
    if (!obj || !Array.isArray(obj.properties)) return null;
    const set = obj.properties.find((s) => norm(s && s.name) === norm(name));
    if (!set) return null;
    const out = {};
    for (const p of set.properties || []) if (p && p.name != null) out[String(p.name).normalize("NFC")] = p.value;
    return out;
  }

  const R = { pos: "Pos/Позиция", size: "Size/Диаметър", qty: "Qty_in_Group/Брой_в_Група", weight: "Group_Weight/Тегло_Група",
    spacing: "Spacing/Разстояние" };
  /**
   * Rebar of one PourUnit (pset Rebar/Армировка) as the distinct Tekla rebar groups: position, diameter, bars in
   * the group, group weight. NOT summed: Tekla's IFC export can split one rebar group into several IfcReinforcingBar
   * objects that each repeat the whole group's Qty and weight (1028: a footing's bars add up to 1,013 kg against
   * 158 kg in the pour data). The pour's total comes from Rebar_Weight instead. `objects` = IFC objects per group.
   */
  function summariseRebars(recs) {
    const map = new Map();
    for (const r of recs || []) {
      const pos = String(r[R.pos] == null ? "?" : r[R.pos]).trim() || "?";
      const size = String(r[R.size] == null ? "" : r[R.size]).trim();
      const qty = num(r[R.qty]) || 1, weight = num(r[R.weight]);
      const spacing = String(r[R.spacing] == null ? "" : r[R.spacing]).trim();
      const k = [pos, size, qty, weight.toFixed(3), spacing].join("|");
      if (!map.has(k)) map.set(k, { pos, size, qty, weight, spacing, objects: 0 });
      map.get(k).objects += 1;
    }
    return [...map.values()].sort((a, b) => naturalCompare(a.pos, b.pos) || b.qty - a.qty);
  }

  /**
   * Rebar list for a whole pour from the per-piece group lists (summariseRebars output of each piece).
   * Within one piece, exact duplicate rows (same Pos, Ø, pcs/gr, kg/gr) are dropped: they are the split-group
   * copies. Then rows are combined across pieces by Pos + Ø, adding pcs and kg. Sorted naturally by Pos.
   * @returns {rows: [{pos, size, qty, weight}], qty, weight}
   */
  function pourRebarList(pieceLists) {
    const map = new Map();
    for (const list of pieceLists || []) {
      const seen = new Set();
      for (const r of list || []) {
        const k = [r.pos, r.size, r.qty, Number(r.weight).toFixed(3)].join("|");
        if (seen.has(k)) continue;
        seen.add(k);
        const key = r.pos + "|" + r.size;
        if (!map.has(key)) map.set(key, { pos: r.pos, size: r.size, qty: 0, weight: 0 });
        const e = map.get(key);
        e.qty += num(r.qty);
        e.weight += num(r.weight);
      }
    }
    const rows = [...map.values()].sort((a, b) => naturalCompare(a.pos, b.pos) || naturalCompare(a.size, b.size));
    return { rows, qty: rows.reduce((n, r) => n + r.qty, 0), weight: rows.reduce((n, r) => n + r.weight, 0) };
  }

  /**
   * Optional Rebar_List/Армировка_Списък (newer Arsten_PourExport, counted in Tekla per pour object):
   * "2.1 Ø14 x90 166.6kg; 2.2 Ø8 x126 93.5kg" -> [{pos, size, qty, weight}]. Weight may be missing.
   */
  function parseRebarList(text) {
    const out = [];
    for (const item of str(text).split(/[;\n]/)) {
      const t = item.trim();
      if (!t) continue;
      const m = t.match(/^(\S+)\s+(?:Ø|ø|O|D)?\s*([\d.,]+)\s*[x×]\s*(\d+)(?:\s+([\d.,]+)\s*kg)?$/i);
      if (m) out.push({ pos: m[1], size: m[2].replace(",", "."), qty: parseInt(m[3], 10), weight: m[4] ? num(m[4]) : 0 });
    }
    return out;
  }

  /** Sum per-piece Rebar_List entries for a whole pour by Pos + Ø (no de-duplication: Tekla counted them). */
  function sumRebarLists(lists) {
    const map = new Map();
    for (const list of lists || []) for (const r of list || []) {
      const key = r.pos + "|" + r.size;
      if (!map.has(key)) map.set(key, { pos: r.pos, size: r.size, qty: 0, weight: 0 });
      const e = map.get(key);
      e.qty += r.qty; e.weight += r.weight;
    }
    const rows = [...map.values()].sort((a, b) => naturalCompare(a.pos, b.pos) || naturalCompare(a.size, b.size));
    return { rows, qty: rows.reduce((n, r) => n + r.qty, 0), weight: rows.reduce((n, r) => n + r.weight, 0) };
  }

  /** List total vs pour-data total: differs when more than ~2 % and more than 1 kg apart. */
  function rebarMismatch(listKg, pourKg) {
    const a = num(listKg), b = num(pourKg);
    if (a === 0 && b === 0) return false;
    return Math.abs(a - b) > Math.max(0.02 * Math.max(a, b), 1);   // and at least 1 kg, so tiny pours don't flag on rounding
  }

  /** Numbers may arrive as numbers or display strings ("9,9 m³", "1 234.5"). */
  function num(v) {
    if (v == null || v === "") return 0;
    if (typeof v === "number") return isFinite(v) ? v : 0;
    const m = String(v).replace(/\s/g, "").replace(",", ".").match(/-?\d+(\.\d+)?([eE][-+]?\d+)?/);
    return m ? parseFloat(m[0]) : 0;
  }

  const str = (v) => (v == null ? "" : String(v).trim());

  /** "TAKT 5" -> "TAKT 5"; "takt  05" -> "TAKT 5"; "TAKT" -> null (no number: known data issue). */
  function pourKey(raw) {
    const s = str(raw).replace(/\s+/g, " ");
    if (!s) return { key: null, label: "(empty)" };
    if (!/\d/.test(s)) return { key: null, label: s };
    const m = s.match(/^(.*?)(\d+)\s*$/);
    if (m) return { key: (m[1].trim().toUpperCase() + " " + String(parseInt(m[2], 10))).trim(), label: s };
    return { key: s.toUpperCase(), label: s };
  }

  /** Parse "EB1 x4, AG2" -> [{code:'EB1', count:4}, {code:'AG2', count:1}]. */
  function parseEmbeds(text) {
    const out = [];
    for (const part of str(text).split(/[,;\n]+/)) {
      const t = part.trim();
      if (!t) continue;
      const m = t.match(/^(.*?)\s*[x×*]\s*(\d+)\s*$/i);
      if (m && m[1]) out.push({ code: m[1].trim(), count: parseInt(m[2], 10) });
      else out.push({ code: t, count: 1 });
    }
    return out;
  }

  /** Parse the optional Parts/Елементи text: "Footing/Единични Фундаменти 1400*1400 [F1] x2; Pedestal ... [C3]"
   *  -> [{code: "Footing/Единични Фундаменти 1400*1400 [F1]", count: 2}, ...]. Items are separated by ";" only,
   *  and a count must be written " xN" (with a space), so profiles such as 600.00*400.00 stay intact. */
  function parseParts(text) {
    const out = [];
    for (const piece of str(text).split(/[;\n]/)) {
      const t = piece.trim();
      if (!t) continue;
      const m = t.match(/^(.*\S)\s+[x×]\s*(\d+)$/i);
      if (m) out.push({ code: m[1].trim(), count: parseInt(m[2], 10) });
      else out.push({ code: t, count: 1 });
    }
    return out;
  }

  /** Merge embed lists, summing counts per code, keeping first-seen order. */
  function mergeEmbeds(lists) {
    const map = new Map();
    for (const list of lists) for (const e of list) map.set(e.code, (map.get(e.code) || 0) + e.count);
    return [...map].map(([code, count]) => ({ code, count }));
  }
  /** Tekla writes "(?)" in a position number when the part is not numbered (or numbering is out of date). */
  const isUnnumbered = (code) => /\(\?\)/.test(code);
  const formatEmbeds = (list) => list.map((e) => (e.count > 1 ? `${e.code} x${e.count}` : e.code)).join(", ");

  /** Natural sort: TAKT 2 before TAKT 10. */
  function naturalCompare(a, b) {
    return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: "base" });
  }

  function bboxVolume(b) {
    if (!b) return 0;
    return Math.max(0, b.max.x - b.min.x) * Math.max(0, b.max.y - b.min.y) * Math.max(0, b.max.z - b.min.z);
  }

  /**
   * Group pour objects.
   * @param items [{modelId, id, props: {..pour pset..}, bbox?: {min:{x,y,z}, max:{x,y,z}}}]
   * @returns {pours: Group[], unnumbered: Group[]}  Group = {key, label, objects, totals, embeds, ...}
   */
  function groupPours(items) {
    const groups = new Map();
    const loose = new Map();
    for (const it of items) {
      const pr = it.props || {};
      const { key, label } = pourKey(pr[P.number]);
      const bucket = key ? groups : loose;
      const k = key || label;
      if (!bucket.has(k)) {
        bucket.set(k, {
          key: k, label: key ? k : label, numbered: !!key, objects: [],
          totals: { volume: 0, rebar: 0, fwSides: 0, fwBottom: 0 },
          _embeds: [], _parts: [], types: new Set(), materials: new Set(), phases: new Set(), models: new Set(), date: "",
        });
      }
      const g = bucket.get(k);
      g.objects.push(it);
      g.totals.volume += num(pr[P.volume]);
      g.totals.rebar += num(pr[P.rebar]);
      g.totals.fwSides += num(pr[P.fwSides]);
      g.totals.fwBottom += num(pr[P.fwBottom]);
      g._embeds.push(parseEmbeds(pr[P.embeds]));
      g._parts.push(parseParts(pr[P.parts]));
      if (str(pr[P.type])) g.types.add(str(pr[P.type]));
      if (str(pr[P.material])) g.materials.add(str(pr[P.material]));
      if (str(pr[P.phase])) g.phases.add(str(pr[P.phase]));
      if (str(pr[P.date]) > g.date) g.date = str(pr[P.date]);
      g.models.add(shortModelName(it.modelName || it.modelId));
    }
    const finish = (g) => {
      g.embeds = mergeEmbeds(g._embeds);
      g.parts = mergeEmbeds(g._parts);   // [] for older exports without Parts/Елементи
      delete g._embeds; delete g._parts;
      g.types = [...g.types]; g.materials = [...g.materials]; g.phases = [...g.phases]; g.models = [...g.models];
      g.anchorObject = pickAnchorObject(g.objects);
      return g;
    };
    const byKey = (a, b) => naturalCompare(a.key, b.key);
    return {
      pours: [...groups.values()].map(finish).sort(byKey),
      unnumbered: [...loose.values()].map(finish).sort(byKey),
    };
  }

  /** Model name for display: file name without the extension. */
  const shortModelName = (name) => String(name || "").replace(/\.(ifc|trb|ifczip|tekla)$/i, "");

  /**
   * Pour numbers are project-wide, so pours from several models merge by number. Before grouping, make sure
   * nothing is counted twice:
   *  1. Two versions of one file loaded (same file id): only the latest version counts.
   *  2. The same pour object (same IFC GUID) in two models, e.g. a copy of the file: counted once, from the best model.
   * "Best" = isLatestVersion first, then the model loaded last (higher `order`).
   * @param items  [{modelId, id, guid?, ...}]
   * @param models [{modelId, fileId?, name, versionId?, isLatest?, order?}]
   * @returns {items, warnings: string[]}
   */
  function dedupePourObjects(items, models) {
    const info = new Map((models || []).map((m, i) => [m.modelId, { order: i, ...m }]));
    const rank = (modelId) => {
      const m = info.get(modelId) || {};
      return (m.isLatest === false ? 0 : 1) * 1e6 + (m.order != null ? m.order : 0);
    };
    const nameOf = (modelId) => shortModelName((info.get(modelId) || {}).name || modelId);
    const warnings = [];

    // 1. same file loaded in several versions
    const byFile = new Map();
    for (const m of info.values()) {
      const key = m.fileId || m.modelId;
      if (!byFile.has(key)) byFile.set(key, []);
      byFile.get(key).push(m.modelId);
    }
    const dropModels = new Set();
    for (const ids of byFile.values()) {
      if (ids.length < 2) continue;
      const sorted = [...ids].sort((a, b) => rank(b) - rank(a));
      sorted.slice(1).forEach((id) => dropModels.add(id));
      warnings.push(`${ids.length} versions of ${nameOf(sorted[0])} are loaded: counting the latest only.`);
    }
    let kept = items.filter((it) => !dropModels.has(it.modelId));

    // 2. same pour object (IFC GUID) in several models
    const best = new Map();
    for (const it of kept) {
      if (!it.guid) continue;
      const cur = best.get(it.guid);
      if (!cur || rank(it.modelId) > rank(cur.modelId)) best.set(it.guid, it);
    }
    const dupPairs = new Map();   // "winner|loser" -> count
    kept = kept.filter((it) => {
      if (!it.guid) return true;
      const win = best.get(it.guid);
      if (win === it) return true;
      const k = nameOf(win.modelId) + "|" + nameOf(it.modelId);
      dupPairs.set(k, (dupPairs.get(k) || 0) + 1);
      return false;
    });
    for (const [k, n] of dupPairs) {
      const [w, l] = k.split("|");
      warnings.push(w === l
        ? `${n} pour objects appear twice in ${w}: counted once.`
        : `${n} pour objects are in both ${w} and ${l} (same IFC GUID): counted once, from ${w}.`);
    }
    return { items: kept, warnings };
  }

  /** Largest object of a group: by concrete volume, then by bounding-box volume. */
  function pickAnchorObject(objects) {
    let best = null, bestV = -1, bestB = -1;
    for (const o of objects) {
      const v = num((o.props || {})[P.volume]);
      const b = bboxVolume(o.bbox);
      if (v > bestV + 1e-9 || (Math.abs(v - bestV) <= 1e-9 && b > bestB)) { best = o; bestV = v; bestB = b; }
    }
    return best;
  }

  /** Top centre of a bounding box. */
  function topCentre(b) {
    return { x: (b.min.x + b.max.x) / 2, y: (b.min.y + b.max.y) / 2, z: b.max.z };
  }

  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  /** Plan (XY) distance from a point to a bounding box; 0 when the point is over the box. */
  function planDistance(p, b) {
    const dx = p.x - clamp(p.x, b.min.x, b.max.x);
    const dy = p.y - clamp(p.y, b.min.y, b.max.y);
    return Math.hypot(dx, dy);
  }

  /** Centre of a pour in plan: centres of its objects' boxes, weighted by concrete volume
   *  (bounding-box volume when a pour has no volumes). Null when no object has a box. */
  function pourCentre(objects) {
    const withBox = objects.filter((o) => o.bbox);
    if (!withBox.length) return null;
    const w = (o) => num((o.props || {})[P.volume]);
    const useVol = withBox.some((o) => w(o) > 0);
    let sx = 0, sy = 0, sw = 0;
    for (const o of withBox) {
      const c = topCentre(o.bbox);
      const wt = useVol ? w(o) : (bboxVolume(o.bbox) || 1);
      sx += c.x * wt; sy += c.y * wt; sw += wt;
    }
    return { x: sx / sw, y: sy / sw };
  }

  /**
   * Where a pour's tag goes.
   * The arrow tip sits on concrete: on the top face of the pour object nearest to the pour's centre
   * (the point of that face closest to the centre, so it stays on the object).
   * `away` is the plan direction from `siteCentre` to the pour, for pushing the label out sideways.
   * Units are those of the bounding boxes.
   */
  function tagPlacement(g, siteCentre) {
    const centre = pourCentre(g.objects);
    if (!centre) return null;
    let best = null, bestD = Infinity, bestV = -1;
    for (const o of g.objects) {
      if (!o.bbox) continue;
      const d = planDistance(centre, o.bbox);
      const v = num((o.props || {})[P.volume]) || bboxVolume(o.bbox);
      // nearest object; among objects under the centre, the biggest one
      if (d < bestD - 1e-9 || (Math.abs(d - bestD) <= 1e-9 && v > bestV)) { best = o; bestD = d; bestV = v; }
    }
    const b = best.bbox;
    const tip = { x: clamp(centre.x, b.min.x, b.max.x), y: clamp(centre.y, b.min.y, b.max.y), z: b.max.z };
    let away = { x: 1, y: 0 };
    if (siteCentre) {
      const dx = centre.x - siteCentre.x, dy = centre.y - siteCentre.y, L = Math.hypot(dx, dy);
      if (L > 1e-6) away = { x: dx / L, y: dy / L };
    }
    return { object: best, tip, centre, away };
  }

  /** Centre (plan) of all pours together: the building, for "away from the building" offsets. */
  function siteCentre(groups) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const g of groups) for (const o of g.objects) {
      if (!o.bbox) continue;
      minX = Math.min(minX, o.bbox.min.x); minY = Math.min(minY, o.bbox.min.y);
      maxX = Math.max(maxX, o.bbox.max.x); maxY = Math.max(maxY, o.bbox.max.y);
    }
    return isFinite(minX) ? { x: (minX + maxX) / 2, y: (minY + maxY) / 2 } : null;
  }

  // Label fields in label order. Defaults follow the site format:
  // TAKT 1 / бетон - 37.9 м³ / арм. 500кг / кофр. страни - 200 м² / кофр. долу - 20 м² / клас - C25/30 / закл. ч. - EB01
  const FIELDS = [
    { id: "number", label: "Pour number · Такт", def: true },
    { id: "volume", label: "Concrete volume · бетон (m³)", def: true },
    { id: "rebar", label: "Rebar · арм. (kg)", def: true },
    { id: "fwSides", label: "Formwork sides · кофр. страни (m²)", def: true },
    { id: "fwBottom", label: "Formwork bottom · кофр. долу (m²)", def: true },
    { id: "material", label: "Concrete grade · клас", def: true },
    { id: "type", label: "Pour type · тип", def: false },
    { id: "embeds", label: "Embedded parts · закл. части", def: true },
  ];

  const fmt = (v, d) => String(Number(v.toFixed(d)));
  /** Volume to 1 decimal, but keep 2 for small pours so 0.04 m³ doesn't print as 0. */
  const fmtVolume = (v) => (v > 0 && v < 1 ? fmt(v, 2) : fmt(v, 1));
  // Pour type is written "English/Български": pick the half for the label language.
  const typeName = (t, lang) => { const [en, bg] = t.split("/"); return ((lang === "bg" ? bg : en) || en || t).trim(); };

  /** Label pieces for the chosen fields, in FIELDS order. Empty quantities are left out. */
  function labelParts(g, fields, lang) {
    const on = new Set(fields || FIELDS.filter((f) => f.def).map((f) => f.id));
    const bg = lang === "bg";
    const t = g.totals;
    const out = [];
    for (const f of FIELDS) {
      if (!on.has(f.id)) continue;
      switch (f.id) {
        case "number": out.push(g.label); break;
        case "volume": out.push(bg ? `бетон - ${fmtVolume(t.volume)} м³` : `${fmtVolume(t.volume)} m³`); break;
        case "rebar": if (t.rebar > 0) out.push(bg ? `арм. ${fmt(t.rebar, 0)}кг` : `rebar ${fmt(t.rebar, 0)} kg`); break;
        case "fwSides": if (t.fwSides > 0) out.push(bg ? `кофр. страни - ${fmt(t.fwSides, 1)} м²` : `FW sides ${fmt(t.fwSides, 1)} m²`); break;
        case "fwBottom": if (t.fwBottom > 0) out.push(bg ? `кофр. долу - ${fmt(t.fwBottom, 1)} м²` : `FW bottom ${fmt(t.fwBottom, 1)} m²`); break;
        case "material": if (g.materials.length) out.push(bg ? `клас - ${g.materials.join(", ")}` : g.materials.join("+")); break;
        case "type": if (g.types.length) out.push((bg ? "тип - " : "") + [...new Set(g.types.map((x) => typeName(x, lang)))].join(", ")); break;
        case "embeds": if (g.embeds.length) out.push(bg ? `закл. ч. - ${formatEmbeds(g.embeds)}` : `Embeds ${formatEmbeds(g.embeds)}`); break;
      }
    }
    return out;
  }

  /** Label text. layout "lines" = one field per line (default), "single" = comma-separated. */
  function labelText(g, fields, opts) {
    const o = opts || {};
    const parts = labelParts(g, fields, o.lang || "bg");
    return parts.join((o.layout || "lines") === "single" ? ", " : "\n");
  }

  /** Pour colours, used for the pours AND their labels when "Colour each pour" is on. Every colour reads as
   *  text on Connect's light background (contrast >= 3.5:1 vs #F0F0F0; markups have no outline/halo option),
   *  the first 10 are >= 23 ΔE apart (closest: the two blues, 1 and 10), and none is close to the tag red or the model's default purple.
   *  Similar pairs sit 4+ pour numbers apart. Cycled after 13. */
  const PALETTE = [
    "#1F4FD1", "#9E7700", "#C51162", "#00838F", "#B35900", "#AA00FF", "#2E7D32", "#4E342E", "#9C27B0", "#0D47A1",
    "#880E4F", "#37474F", "#00695C",
  ];
  const colourFor = (index) => PALETTE[index % PALETTE.length];
  function hexToRgba(hex, a) {
    const n = parseInt(hex.slice(1), 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a: a == null ? 255 : a };
  }

  return {
    PSET, P, R, FIELDS, PALETTE, readPourPset, readPset, summariseRebars, pourRebarList, rebarMismatch, parseRebarList, sumRebarLists, parseParts, num, pourKey, parseEmbeds, mergeEmbeds, formatEmbeds, isUnnumbered,
    naturalCompare, groupPours, dedupePourObjects, shortModelName, pickAnchorObject, topCentre, pourCentre, tagPlacement, siteCentre, labelParts, labelText, fmtVolume, colourFor, hexToRgba,
  };
});
