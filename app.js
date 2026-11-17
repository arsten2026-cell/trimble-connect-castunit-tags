// Cast unit tags: Trimble Connect 3D-viewer extension. Lists Tekla cast units (IfcElementAssembly from a
// "CIP cast units or parts" export) with volume and rebar, tags them with leader labels, and shows each cast
// unit's rebar list from Tekla's own rebar objects.
(() => {
  "use strict";
  const C = window.PourLogic;          // shared helpers (common.js)
  const L = window.CastUnitLogic;      // cast unit logic (castunits.js)
  const $ = (id) => document.getElementById(id);
  const TAG_COLOUR = { r: 200, g: 16, b: 46, a: 255 };
  const BATCH = 200;
  const BBOX_TO_MM = 1000;             // bounding boxes come in metres, markups in millimetres
  const HIERARCHY_ASSEMBLY = 4;        // HierarchyType.ElementAssembly
  const FOCUS_OPACITY = 0.5, FOCUS_GREY = "#9E9E9E";

  const state = {
    api: null,
    units: [],             // grouped cast units
    tags: new Map(),       // group key -> [markup ids] (one tag per cast unit instance)
    coloured: false, isolated: false,
    focusKey: null, focusTagAdded: false,
    inspectKey: null,
    filter: "",              // mark filter text
    selKeys: null,           // Show selected: cast unit keys of the model selection (null = off)
    selPrefixes: new Set(),   // prefix groups currently selected (Tag by group)
  };

  // ---------- settings ----------
  const SETTINGS_KEY = "arsten.castUnitTags.v1";
  const settings = (() => {
    let s = {};
    try { s = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}"); } catch {}
    const known = new Set(L.FIELDS.map((f) => f.id));
    return {
      fields: (s.fields || L.FIELDS.filter((f) => f.def).map((f) => f.id)).filter((id) => known.has(id)),
      // defaults 1 m up, 1 m sideways (user's choice 2026-11-09); settings saved before v2 still had the old 3 m
      // defaults, so those move to the new defaults while the chosen fields and language are kept
      lift: s.v >= 2 && s.lift ? s.lift : 1,
      side: s.v >= 2 && s.side != null ? s.side : 1,
      v: 2,
      lang: s.lang === "en" ? "en" : "bg", layout: s.layout === "single" ? "single" : "lines",
    };
  })();
  const saveSettings = () => { try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch {} };

  // ---------- interface language (A10): shared with every tool (shared/arsten-i18n.js); BG by default ----------
  // Not the label language: settings.lang is what the tags in the model say.
  const I18N = window.ArstenI18n;
  let ui = I18N ? I18N.getLang() : "bg";
  const L2 = (b, e) => (ui === "bg" ? b : e);
  const pl = (n, one, many, en1, enN) => (ui === "bg" ? (I18N ? I18N.plural(n, one, many) : many) : n === 1 ? en1 : enN);
  const unitsWord = (n) => `${n} ${pl(n, "елемент", "елемента", "cast unit", "cast units")}`;   // not "units": loadCastUnits has a local of that name (round 19 H1)
  /** The static texts of index.html: data-en / data-en-title / data-en-ph hold the English, the Bulgarian is kept on first use. */
  function applyStatic() {
    document.documentElement.lang = ui;
    if ($("selUi")) $("selUi").value = ui;
    document.querySelectorAll("[data-en]").forEach((el) => { if (el.dataset.bg == null) el.dataset.bg = el.textContent; el.textContent = ui === "en" ? el.dataset.en : el.dataset.bg; });
    document.querySelectorAll("[data-en-title]").forEach((el) => { if (el.dataset.bgTitle == null) el.dataset.bgTitle = el.title; el.title = ui === "en" ? el.dataset.enTitle : el.dataset.bgTitle; });
    document.querySelectorAll("[data-en-ph]").forEach((el) => { if (el.dataset.bgPh == null) el.dataset.bgPh = el.placeholder; el.placeholder = ui === "en" ? el.dataset.enPh : el.dataset.bgPh; });
  }
  /** A field name of castunits.js ("Mark · марка") in the interface language. */
  const fieldName = (f) => { const [en, bg] = String(f.label).split(" · "); return ui === "en" || !bg ? en : bg.charAt(0).toUpperCase() + bg.slice(1); };
  /** The model-check warnings of common.js (English) in the interface language. */
  function warnText(w) {
    if (ui === "en") return w;
    return String(w)
      .replace(/^(\d+) versions of (.+) are loaded: counting the latest only\.$/, "Заредени са $1 версии на $2: брои се само последната.")
      .replace(/^(\d+) pour objects appear twice in (.+): counted once\.$/, "$1 обекта са два пъти в $2: броят се веднъж.")
      .replace(/^(\d+) pour objects are in both (.+) and (.+) \(same IFC GUID\): counted once, from (.+)\.$/, "$1 обекта са и в $2, и в $3 (същият IFC GUID): броят се веднъж, от $4.");
  }
  // text may be a function: then it is built again in the new language after a language switch (round 19 L4)
  let statusAgain = null;
  function setStatus(text, bad) {
    statusAgain = typeof text === "function" ? { text, bad } : null;
    $("status").textContent = typeof text === "function" ? text() : text; $("status").className = "status" + (bad ? " bad" : "");
  }
  const relabelStatus = () => { if (statusAgain) setStatus(statusAgain.text, statusAgain.bad); if (window.ArstenDiag && ArstenDiag.relabel) ArstenDiag.relabel(); };
  const errText = (e) => (e && (e.message || e.toString())) || String(e);
  const objKey = (o) => o.modelId + ":" + o.id;

  // Run async jobs a few at a time.
  async function pool(items, n, fn) {
    const out = new Array(items.length);
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
      while (next < items.length) { const k = next++; out[k] = await fn(items[k], k); }
    }));
    return out;
  }

  // ---------- reading the model ----------
  async function loadCastUnits() {
    const api = state.api;
    setStatus(L2("Четене на елементите от заредените модели…", "Reading cast units from the loaded models…"));
    const modelObjs = (await api.viewer.getObjects()) || [];
    const units = [];
    let scanned = 0, noParent = 0;
    for (const m of modelObjs) {
      const ids = (m.objects || []).map((o) => o.id);
      const props = new Map();
      for (let i = 0; i < ids.length; i += BATCH) {
        for (const p of (await api.viewer.getObjectProperties(m.modelId, ids.slice(i, i + BATCH))) || []) props.set(p.id, p);
        scanned += Math.min(BATCH, ids.length - i);
        setStatus(L2(`Четене на елементите… проверени ${scanned} обекта`, `Reading cast units… ${scanned} objects checked`));
      }
      const isRebar = (p) => !!C.readPset(p, L.REBAR_PSET);
      const isAssembly = (p) => /elementassembly/i.test(String(p.class || ""));
      const partIds = [...props.values()].filter((p) => !isRebar(p) && !isAssembly(p) && C.readPset(p, L.PART_PSET)).map((p) => p.id);
      // Cast units: assemblies listed by getObjects, or else the ElementAssembly parent of each concrete part.
      const parents = new Map();   // assembly id -> {id, name}
      for (const p of props.values()) if (isAssembly(p)) parents.set(p.id, { id: p.id, name: (p.product && p.product.name) || "" });
      if (!parents.size) {
        await pool(partIds, 8, async (id) => {
          try {
            const ps = (await api.viewer.getHierarchyParents(m.modelId, [id], HIERARCHY_ASSEMBLY)) || [];
            if (ps[0]) { if (!parents.has(ps[0].id)) parents.set(ps[0].id, { id: ps[0].id, name: ps[0].name || "" }); }
            else noParent++;
          } catch { noParent++; }
        });
        setStatus(L2(`Четене на елементите… намерени ${parents.size}`, `Reading cast units… ${parents.size} found`));
      }
      const parentIds = [...parents.keys()];
      // the cast unit pset sits on the assembly itself
      const unitProps = new Map();
      for (let i = 0; i < parentIds.length; i += BATCH) {
        try { for (const p of (await api.viewer.getObjectProperties(m.modelId, parentIds.slice(i, i + BATCH))) || []) unitProps.set(p.id, p); } catch {}
      }
      let guids = [];
      try { guids = (await api.viewer.convertToObjectIds(m.modelId, parentIds)) || []; } catch {}
      const kids = await pool(parentIds, 8, async (pid) => {
        try { return ((await api.viewer.getHierarchyChildren(m.modelId, [pid], HIERARCHY_ASSEMBLY)) || []).map((c) => c.id); }
        catch { return []; }
      });
      // children not in the getObjects list (rare): read their properties too
      const missing = [...new Set(kids.flat())].filter((id) => !props.has(id));
      for (let i = 0; i < missing.length; i += BATCH) {
        try { for (const p of (await api.viewer.getObjectProperties(m.modelId, missing.slice(i, i + BATCH))) || []) props.set(p.id, p); } catch {}
      }
      const partSet = new Set();
      parentIds.forEach((pid, k) => {
        const up = unitProps.get(pid);
        const parts = [], rebars = [];
        for (const cid of kids[k]) {
          const p = props.get(cid);
          if (!p) continue;
          const rb = C.readPset(p, L.REBAR_PSET);
          if (rb) rebars.push({ modelId: m.modelId, id: cid, props: rb });
          else if (!isAssembly(p)) { parts.push({ modelId: m.modelId, id: cid, props: C.readPset(p, L.PART_PSET) || {} }); partSet.add(cid); }
        }
        if (!parts.length && !rebars.length) return;
        units.push({ modelId: m.modelId, id: pid, guid: guids[k] || null,
          name: (up && up.product && up.product.name) || parents.get(pid).name || "",
          cu: up ? C.readPset(up, L.CU_PSET) : null, parts, rebars });
      });
      // bounding boxes of the concrete parts (tag anchors)
      const pids = [...partSet];
      const boxes = new Map();
      for (let i = 0; i < pids.length; i += BATCH) {
        try { for (const b of (await api.viewer.getObjectBoundingBoxes(m.modelId, pids.slice(i, i + BATCH))) || []) boxes.set(b.id, b.boundingBox); } catch {}
      }
      for (const u of units) if (u.modelId === m.modelId) for (const p of u.parts) p.bbox = boxes.get(p.id) || null;
    }
    // several models: names, and never count two versions of one file
    const models = await loadedModels(modelObjs);
    const names = new Map(models.map((x) => [x.modelId, x.name]));
    for (const u of units) u.modelName = names.get(u.modelId) || u.modelId;
    const dd = C.dedupePourObjects(units, models);
    const groups = L.groupCastUnits(dd.items);
    groups.forEach((g, i) => { g.colour = C.colourFor(i); });
    state.units = groups;
    state.multiModel = new Set(dd.items.map((u) => u.modelId)).size > 1;
    render();
    if (!groups.length) {
      setStatus(() => L2(`Няма бетонови елементи: проверени ${scanned} обекта. Заредете Tekla IFC, експортиран с „CIP cast units or parts“.`, `No cast units found: ${scanned} objects checked. Load a Tekla IFC exported with "CIP cast units or parts".`) +
        (noParent ? L2(` ${noParent} бетонови части нямат родителски елемент.`, ` ${noParent} concrete parts have no cast unit parent.`) : ""), true);
    } else {
      const withPset = dd.items.filter((u) => u.cu).length;
      const rebarKg = groups.reduce((n, g) => n + g.totals.rebar, 0);
      setStatus(() => L2(`${unitsWord(dd.items.length)} в ${groups.length} ${groups.length === 1 ? "ред" : "реда"}, ${f1(rebarKg)} kg армировка`, `${unitsWord(dd.items.length)} in ${groups.length} ${groups.length === 1 ? "row" : "rows"}, ${f1(rebarKg)} kg rebar`) +
        (state.multiModel ? L2(` от ${new Set(dd.items.map((u) => u.modelId)).size} модела`, ` from ${new Set(dd.items.map((u) => u.modelId)).size} models`) : "") +
        (dd.warnings.length ? " · ⚠ " + dd.warnings.map(warnText).join(" ") : ""), dd.warnings.length > 0);
      $("cuWarn").hidden = withPset === dd.items.length;
      $("cuWarn").textContent = withPset === 0
        ? L2(`Този експорт няма набор свойства на елемента (${L.CU_PSET}), затова марките са „?“, а името идва от сглобката. ` +
          "Експортирайте отново от Tekla с филтрите за набори свойства на фирмата, за да има марки, обем и Rebar_Weight.",
          `This export has no cast unit property set (${L.CU_PSET}), so marks show as "?" and the name comes from the assembly. ` +
          "Export again from Tekla with the firm's property set filters to get marks, volume and Rebar_Weight.")
        : L2(`${dd.items.length - withPset} от ${dd.items.length} ${pl(dd.items.length, "елемент", "елемента")} ${dd.items.length - withPset === 1 ? "няма" : "нямат"} набор свойства ${L.CU_PSET} (марка „?“).`, `${dd.items.length - withPset} of ${dd.items.length} cast units have no ${L.CU_PSET} property set (mark "?").`);
    }
    for (const b of ["btnShowAll", "btnClear", "btnReload"]) $(b).disabled = false;
  }

  async function loadedModels(modelObjs) {
    let specs = [];
    try { specs = (await state.api.viewer.getModels("loaded")) || []; } catch {}
    const byId = new Map(specs.map((m) => [m.id, m]));
    return (modelObjs || []).map((mo, order) => {
      const m = byId.get(mo.modelId) || specs.find((x) => x.versionId === mo.modelId) || {};
      return { modelId: mo.modelId, fileId: m.id || mo.modelId, name: m.name || mo.modelId, versionId: m.versionId, isLatest: m.isLatestVersion, order };
    });
  }

  // ---------- selectors ----------
  // cast units in the list after the mark filter
  function isShown(g) { return state.selKeys ? state.selKeys.has(g.key) : L.matchMark(g.mark || g.label, state.filter); }
  function shownUnits() { return state.units.filter(isShown); }
  // "Show selected": list the cast units of what is selected in the model (concrete part, rebar or the assembly).
  async function showSelected() {
    const sel = (await state.api.viewer.getSelection()) || [];
    const index = new Map();   // object key -> cast unit key
    for (const g of state.units) {
      for (const o of [...g.objects, ...g.rebars]) index.set(objKey(o), g.key);
      for (const u of g.instances) index.set(u.modelId + ":" + u.id, g.key);
    }
    const keys = new Set();
    let n = 0;
    for (const m of sel) for (const id of m.objectRuntimeIds || []) { n++; const k = index.get(m.modelId + ":" + id); if (k) keys.add(k); }
    if (!n) return setStatus(L2("Нищо не е избрано в модела. Изберете елементи и натиснете „Покажи избраните“.", "Nothing is selected in the model. Select cast units first, then click Show selected."), true);
    if (!keys.size) return setStatus(L2(`Нито един от избраните ${n} ${pl(n, "обект", "обекта")} не е в бетонов елемент.`, `None of the ${n} selected objects belongs to a cast unit.`), true);
    state.selKeys = keys;
    state.filter = ""; $("txtFilter").value = "";
    setStatus(L2(`Показани са ${unitsWord(keys.size)} от избора (${n} ${pl(n, "обект", "обекта")}).`, `Showing the ${keys.size} cast unit${keys.size > 1 ? "s" : ""} of the selection (${n} objects).`));
    render();
    if (state.isolated) await applyIsolate();
  }
  function selectorFor(objects) {
    const byModel = new Map();
    for (const o of objects) { if (!byModel.has(o.modelId)) byModel.set(o.modelId, []); byModel.get(o.modelId).push(o.id); }
    return { modelObjectIds: [...byModel].map(([modelId, objectRuntimeIds]) => ({ modelId, objectRuntimeIds })) };
  }
  const allParts = () => state.units.flatMap((g) => g.objects);

  // ---------- tags: one per cast unit instance ----------
  function markupsFor(g, index) {
    const site = C.siteCentre(state.units);
    const lift = settings.lift * 1000 * (1 + 0.3 * (index % 3));
    const side = settings.side * 1000;
    const colour = (state.coloured || state.focusKey === g.key) && g.colour ? C.hexToRgba(g.colour) : TAG_COLOUR;
    const text = L.labelText(g, settings.fields, settings);
    const out = [];
    for (const inst of g.instances) {
      const pl = C.tagPlacement({ objects: inst.parts }, site);
      if (!pl) continue;
      const k = BBOX_TO_MM, p = { x: pl.tip.x * k, y: pl.tip.y * k, z: pl.tip.z * k };
      out.push({ text, color: colour,
        start: { positionX: p.x, positionY: p.y, positionZ: p.z, modelId: pl.object.modelId, objectId: pl.object.id },
        end: { positionX: p.x + pl.away.x * side, positionY: p.y + pl.away.y * side, positionZ: p.z + lift } });
    }
    return out;
  }
  async function addTags(groups) {
    let n = 0;
    for (const g of groups) {
      const ms = markupsFor(g, state.units.indexOf(g));
      if (!ms.length) continue;
      const old = state.tags.get(g.key) || [];
      ms.forEach((m, k) => { if (old[k] != null) m.id = old[k]; });
      const extra = old.slice(ms.length);
      if (extra.length) await state.api.markup.removeMarkups(extra);
      const res = (await state.api.markup.addTextMarkup(ms)) || [];
      state.tags.set(g.key, res.map((r) => r && r.id).filter((id) => id != null));
      n++;
    }
    return n;
  }
  async function removeTags(keys) {
    const ids = keys.flatMap((k) => state.tags.get(k) || []);
    if (ids.length) await state.api.markup.removeMarkups(ids);
    keys.forEach((k) => state.tags.delete(k));
  }
  async function showAll() {
    const n = await addTags(state.units);
    setStatus(L2(`Етикети: ${unitsWord(n)}`, `${n} cast units tagged`) + (n < state.units.length ? L2(` · ${state.units.length - n} нямат геометрия за етикета`, ` · ${state.units.length - n} have no geometry to anchor to`) : ""));
    render();
  }
  async function clearAll() { await removeTags([...state.tags.keys()]); setStatus(L2("Етикетите са изчистени", "Tags cleared")); render(); }
  async function refreshTags() { if (state.tags.size) await addTags(state.units.filter((g) => state.tags.has(g.key))); }

  // ---------- colours / isolate / select / focus ----------
  async function applyColours() {
    const all = allParts();
    if (!all.length) return;
    if (!state.coloured) return state.api.viewer.setObjectState(selectorFor(all), { color: "reset" });
    // one call per colour, not per cast unit (speed audit item 4)
    for (const b of L.colourBatches(state.units.map((g) => ({ objects: g.objects, colour: g.colour })))) await state.api.viewer.setObjectState(selectorFor(b.objects), { color: b.colour });
  }
  // "Show listed cast units only": only the cast units in the list (after the filter box) stay visible, concrete
  // and rebar. Uses viewer.isolateEntities (as the MCP bridge's verified isolate does); hiding "everything else"
  // with setObjectState hid the cast units too. Unticking resets visibility.
  async function applyIsolate() {
    const api = state.api;
    if (state.isolated) {
      const keep = shownUnits().flatMap((g) => [...g.objects, ...g.rebars]);
      const byModel = new Map();
      for (const o of keep) { if (!byModel.has(o.modelId)) byModel.set(o.modelId, []); byModel.get(o.modelId).push(o.id); }
      await api.viewer.isolateEntities([...byModel].map(([modelId, entityIds]) => ({ modelId, entityIds })));
    } else {
      await api.viewer.setObjectState(undefined, { visible: "reset" });
      const all = await everyObject();
      if (all.length) await api.viewer.setObjectState(selectorFor(all), { visible: true });
    }
  }
  async function selectObjects(objs) {
    if (!objs.length) return;
    if (state.selPrefixes.size) { state.selPrefixes.clear(); render(); }
    const sel = selectorFor(objs);
    await state.api.viewer.setSelection(sel, "set");
    await state.api.viewer.setCamera(sel, { animationTime: 600 });
  }
  async function everyObject() {
    const out = [];
    for (const m of (await state.api.viewer.getObjects()) || []) for (const o of m.objects || []) out.push({ modelId: m.modelId, id: o.id });
    return out;
  }
  // Focus: only this cast unit (concrete + rebar) in colour, everything else grey at 50%; it is also tagged.
  async function focusUnit(g) {
    if (state.focusKey === g.key) return clearFocus();
    const api = state.api;
    await dropFocusTag();
    state.focusKey = g.key;
    state.focusTagAdded = !state.tags.has(g.key);
    await addTags([g]);
    render();
    const mine = [...g.objects, ...g.rebars];
    const keys = new Set(mine.map(objKey));
    const others = (await everyObject()).filter((o) => !keys.has(objKey(o)));
    if (others.length) await api.viewer.setObjectState(selectorFor(others), { color: FOCUS_GREY, opacity: FOCUS_OPACITY });
    await api.viewer.setObjectState(selectorFor(mine), { color: g.colour, opacity: 1 });
    await api.viewer.setCamera(selectorFor(g.objects.length ? g.objects : mine), { animationTime: 600 });
  }
  async function dropFocusTag() {
    const key = state.focusKey;
    if (key == null) return;
    if (state.focusTagAdded) await removeTags([key]);
    else { const g = state.units.find((u) => u.key === key); if (g) { state.focusKey = null; await addTags([g]); } }
    state.focusTagAdded = false;
  }
  async function clearFocus() {
    if (state.focusKey == null) return;
    await dropFocusTag();
    state.focusKey = null;
    render();
    const all = await everyObject();
    if (all.length) await state.api.viewer.setObjectState(selectorFor(all), { color: "reset", opacity: 1 });
    if (state.coloured) await applyColours();
  }

  // ---------- rendering ----------
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  // numbers in the interface language: BG "3 292" / "37,9", EN "3,292" / "37.9" (round 15 L8)
  const fNum = (v, d) => (I18N && I18N.fmtNum ? I18N.fmtNum(v, ui, d) : (Math.round(v * 10 ** d) / 10 ** d).toLocaleString(ui === "en" ? "en-US" : "bg-BG"));
  const f1 = (v) => fNum(v, 1);
  const f0 = (v) => fNum(v, 0);

  function inspectRow(g, i) {
    const t = L.rebarTable(g.rebars);
    let reb;
    if (!t.rows.length) reb = `<div class="sub">${L2("Няма армировка в този елемент.", "No rebar in this cast unit.")}</div>`;
    else {
      reb = `<table class="rebars"><tr><th>Pos</th><th>Ø</th><th class="num">${L2("бр.", "pcs")}</th><th class="num">kg</th></tr>` +
        t.rows.map((r) => `<tr><td>${esc(r.pos)}</td><td>${esc(r.size)}</td><td class="num">${f0(r.qty)}</td><td class="num">${f1(r.weight)}</td></tr>`).join("") +
        `<tr class="tot"><td colspan="2">${L2("Общо", "Total")}</td><td class="num">${f0(t.qty)}</td><td class="num">${f1(t.weight)}</td></tr></table>`;
      const ps = g.totals.psetRebar;
      if (ps != null) {
        reb += C.rebarMismatch(t.weight, ps)
          ? `<div class="mism">${L2(`Списък ${f1(t.weight)} kg срещу Rebar_Weight ${f1(ps)} kg в данните на елемента.`, `List ${f1(t.weight)} kg vs Rebar_Weight ${f1(ps)} kg in the cast unit data.`)}</div>`
          : `<div class="sub">${L2(`Съвпада с Rebar_Weight (${f1(ps)} kg).`, `Matches Rebar_Weight (${f1(ps)} kg).`)}</div>`;
      } else reb += `<div class="sub">${L2("От армировъчните обекти на Tekla (в този експорт няма Rebar_Weight за сравнение).", "From Tekla's rebar objects (no Rebar_Weight in this export to compare).")}</div>`;
      reb += `<div class="acts"><button class="small secondary" data-act="selRebar" data-i="${i}">${L2("Избери армировката", "Select rebar")}</button></div>`;
    }
    return `<tr class="insp"><td colspan="3">
        <div class="insphead">${esc(g.label)} · ${g.rebars.length} ${L2("армировъчни обекта", "rebar objects")}</div>
        <div class="pourlists"><div class="lh">${L2("Армировка", "Rebar")}</div>${reb}</div></td></tr>`;
  }

  function render() {
    const rows = $("rows");
    if (!state.units.length) {
      rows.innerHTML = `<tr><td colspan="3" class="empty">${L2("В заредените модели няма бетонови елементи.", "No cast units in the loaded models.")}</td></tr>`;
      $("foot").innerHTML = "";
      return;
    }
    // mark filter (box next to "Cast units"): rows keep their index in state.units for the buttons
    const shown = isShown;
    const visible = state.units.filter(shown);
    const firstLoose = state.units.findIndex((g) => !g.numbered && shown(g));
    const looseCount = visible.filter((g) => !g.numbered).length;
    if (!visible.length) {
      rows.innerHTML = `<tr><td colspan="3" class="empty">${L2(`Няма марка, която отговаря на „${esc(state.filter)}“.`, `No cast unit mark matches "${esc(state.filter)}".`)}</td></tr>`;
      $("filterActs").hidden = true;
    } else rows.innerHTML = state.units.map((g, i) => {
      if (!shown(g)) return "";
      const tagged = state.tags.has(g.key);
      const name = g.name.split("/")[0] || "–";
      // Unnumbered cast units (mark "(?)" or none) in their own section, like bare "TAKT" pours in Pour tags.
      const head = i === firstLoose
        ? `<tr class="sect"><td colspan="3"><h2>${L2("Без номер", "Not numbered")} (${looseCount})</h2><div class="warn">${L2("Марки, завършващи на „(?)“, значат, че номерирането в Tekla не е било обновено при експорта, така че са временни: всеки елемент е на отделен ред. Пуснете номериране в Tekla и експортирайте отново, за да има истински марки.", "Marks ending in \"(?)\" mean Tekla numbering was not up to date at export, so these marks are placeholders: each cast unit is listed on its own. Run numbering in Tekla and export again to get real marks.")}</div></td></tr>`
        : "";
      return head + `<tr>
        <td>${state.coloured ? `<span class="sw" style="background:${g.colour}"></span>` : ""}<span class="name">${esc(g.label)}</span><button
            class="small inspect ${state.inspectKey === g.key ? "on" : "secondary"}" data-act="inspect" data-i="${i}" title="${L2("Списък на армировката на елемента", "Rebar list of this cast unit")}">${L2("Виж", "Inspect")} ${state.inspectKey === g.key ? "▴" : "▾"}</button>
          <div class="sub">${esc(name)}${g.positions.length ? " · " + esc(g.positions.slice(0, 4).join(", ")) + (g.positions.length > 4 ? " …" : "") : ""}${g.materials.length ? " · " + esc(g.materials.join(", ")) : ""}</div>
          ${state.multiModel ? `<div class="sub">${esc(C.shortModelName(g.modelName))}</div>` : ""}
          <div class="acts"><button class="small ${tagged ? "on" : "secondary"}" data-act="tag" data-i="${i}">${L2("Етикет", "Tag")}</button><button
            class="small secondary" data-act="select" data-i="${i}" title="${L2("Избери бетона и приближи", "Select the concrete and zoom to it")}">${L2("Избери", "Select")}</button><button
            class="small ${state.focusKey === g.key ? "on" : "secondary"}" data-act="focus" data-i="${i}" title="${state.focusKey === g.key ? L2("Без фокус", "Clear focus") : L2("Само този елемент в цвят, останалото сиво", "Only this cast unit in colour, the rest grey")}">${L2("Фокус", "Focus")}</button></div></td>
        <td class="num">${C.fmtVolume(g.totals.volume, ui)}</td>
        <td class="num">${f0(g.totals.rebar)}</td></tr>` + (state.inspectKey === g.key ? inspectRow(g, i) : "");
    }).join("");
    const t = visible.reduce((a, g) => ({ v: a.v + g.totals.volume, r: a.r + g.totals.rebar }), { v: 0, r: 0 });
    const filtered = visible.length !== state.units.length;
    $("foot").innerHTML = `<tr><td>${filtered ? L2(`Показани (${visible.length} от ${state.units.length})`, `Shown (${visible.length} of ${state.units.length})`) : L2(`Общо (${state.units.length})`, `Total (${state.units.length})`)}</td><td class="num">${f1(t.v)}</td><td class="num">${f0(t.r)}</td></tr>`;
    $("filterActs").hidden = !filtered || !visible.length;
    $("filterCount").textContent = filtered ? `${visible.length} ${state.selKeys ? L2("избрани", "selected") : L2("показани", "shown")}` : "";
    $("btnShowAllRows").hidden = !state.selKeys;
    $("btnShowSel").className = "small " + (state.selKeys ? "on" : "secondary");
    $("btnClearFocus").hidden = state.focusKey == null;
    renderPrefixBar();
  }
  // Select by group adds to the selection, so several groups can be selected together (e.g. FP + FS);
  // clicking a selected group again removes only that group.
  async function togglePrefixSelection(prefix, members) {
    const objs = members.flatMap((u) => u.objects);
    if (!objs.length) return;
    const sel = selectorFor(objs);
    if (state.selPrefixes.has(prefix)) {
      state.selPrefixes.delete(prefix);
      await state.api.viewer.setSelection(sel, "remove");
    } else {
      // first group: start a fresh selection; further groups: add to it
      await state.api.viewer.setSelection(sel, state.selPrefixes.size ? "add" : "set");
      state.selPrefixes.add(prefix);
      const all = state.units.filter((u) => state.selPrefixes.has(u.prefix)).flatMap((u) => u.objects);
      await state.api.viewer.setCamera(selectorFor(all), { animationTime: 600 });
    }
    const list = [...state.selPrefixes];
    setStatus(list.length ? L2(`Избрани: ${list.join(" + ")} (${unitsWord(state.units.filter((u) => state.selPrefixes.has(u.prefix)).length)})`, `Selected: ${list.join(" + ")} (${state.units.filter((u) => state.selPrefixes.has(u.prefix)).length} cast units)`) : L2("Изборът е изчистен", "Selection cleared"));
    render();
  }
  // "Tag by group": one chip per mark prefix with Tag (toggles all) and Select.
  function renderPrefixBar() {
    const groups = L.prefixGroups(state.units);
    $("prefixBox").hidden = groups.length < 2;
    $("prefixBar").innerHTML = groups.map(({ prefix, count }) => {
      const members = state.units.filter((u) => u.prefix === prefix);
      const on = members.every((u) => state.tags.has(u.key));
      return `<span class="chip"><b>${esc(prefix)}</b> <span class="sub">${count}</span><button
        class="small ${on ? "on" : "secondary"}" data-act="pfxTag" data-p="${esc(prefix)}" title="${on ? L2(`Махни етикетите на ${esc(prefix)}`, `Remove the tags of ${esc(prefix)} cast units`) : L2(`Етикети на всички ${esc(prefix)}`, `Tag all ${esc(prefix)} cast units`)}">${L2("Етикет", "Tag")}</button><button
        class="small ${state.selPrefixes.has(prefix) ? "on" : "secondary"}" data-act="pfxSel" data-p="${esc(prefix)}" title="${state.selPrefixes.has(prefix) ? L2(`Махни ${esc(prefix)} от избора`, `Remove ${esc(prefix)} cast units from the selection`) : L2(`Добави ${esc(prefix)} към избора`, `Add ${esc(prefix)} cast units to the selection`)}">${L2("Избери", "Select")}</button></span>`;
    }).join("");
  }

  function renderFieldOptions() {
    $("fields").innerHTML = L.FIELDS.map((f) =>
      `<label class="chk"><input type="checkbox" data-field="${f.id}" ${settings.fields.includes(f.id) ? "checked" : ""}> ${esc(fieldName(f))}</label>`).join("");
    $("numLift").value = settings.lift; $("numSide").value = settings.side;
    $("selLang").value = settings.lang; $("selLayout").value = settings.layout;
  }

  // ---------- wiring ----------
  async function guarded(fn) { try { await fn(); } catch (e) { setStatus(I18N ? I18N.err(errText(e), ui) : "Error: " + errText(e), true); console.error(e); } }
  document.addEventListener("click", (e) => {
    const b = e.target.closest("button[data-act]");
    if (!b) return;
    // tag / select a whole group by mark prefix (FP, FS, W, ...)
    if (b.dataset.act === "pfxTag" || b.dataset.act === "pfxSel") {
      const members = state.units.filter((u) => u.prefix === b.dataset.p);
      guarded(async () => {
        if (b.dataset.act === "pfxSel") return togglePrefixSelection(b.dataset.p, members);
        const allTagged = members.every((u) => state.tags.has(u.key));
        if (allTagged) await removeTags(members.map((u) => u.key));
        else await addTags(members.filter((u) => !state.tags.has(u.key)));
        setStatus(`${b.dataset.p}: ${allTagged ? L2("етикетите са махнати", "tags removed") : L2(`етикети: ${unitsWord(members.length)}`, members.length + " cast units tagged")}`);
        render();
      });
      return;
    }
    const g = state.units[+b.dataset.i];
    if (!g) return;
    guarded(async () => {
      const act = b.dataset.act;
      if (act === "tag") {
        if (state.tags.has(g.key)) await removeTags([g.key]);
        else if (!(await addTags([g]))) setStatus(`${g.label}: ${L2("няма геометрия за етикета", "no geometry to anchor the tag")}`, true);
        render();
      } else if (act === "inspect") { state.inspectKey = state.inspectKey === g.key ? null : g.key; render(); }
      else if (act === "select") await selectObjects(g.objects);
      else if (act === "focus") await focusUnit(g);
      else if (act === "selRebar") await selectObjects(g.rebars);
    });
  });
  // filter box: re-render as you type; Tag shown / Select shown act on the filtered rows
  let isoTimer = null;
  $("txtFilter").addEventListener("input", (e) => {
    state.filter = e.target.value;
    state.selKeys = null;     // typing replaces the selection filter
    render();
    if (state.isolated) { clearTimeout(isoTimer); isoTimer = setTimeout(() => guarded(applyIsolate), 400); }
  });
  $("btnShowSel").onclick = () => guarded(showSelected);
  $("btnShowAllRows").onclick = () => guarded(async () => { state.selKeys = null; render(); if (state.isolated) await applyIsolate(); });
  $("btnTagShown").onclick = () => guarded(async () => {
    const vis = shownUnits();
    const allTagged = vis.every((u) => state.tags.has(u.key));
    if (allTagged) await removeTags(vis.map((u) => u.key));
    else await addTags(vis.filter((u) => !state.tags.has(u.key)));
    setStatus(`${state.selKeys ? L2("Избор", "Selection") : state.filter}: ${allTagged ? L2("етикетите са махнати", "tags removed") : L2(`етикети: ${unitsWord(vis.length)}`, vis.length + " cast units tagged")}`);
    render();
  });
  $("btnSelectShown").onclick = () => guarded(() => selectObjects(shownUnits().flatMap((u) => u.objects)));
  $("btnShowAll").onclick = () => guarded(showAll);
  $("btnClear").onclick = () => guarded(clearAll);
  $("btnClearFocus").onclick = () => guarded(clearFocus);
  $("btnReload").onclick = () => guarded(async () => { await clearFocus(); await removeTags([...state.tags.keys()]); await loadCastUnits(); await applyColours(); });
  $("chkColour").onchange = (e) => guarded(async () => {
    state.coloured = e.target.checked;
    if (state.focusKey == null) await applyColours();
    await refreshTags();
    render();
  });
  $("chkIsolate").onchange = (e) => guarded(async () => { state.isolated = e.target.checked; await applyIsolate(); });
  $("fields").onchange = (e) => {
    const id = e.target.dataset.field;
    if (!id) return;
    settings.fields = L.FIELDS.map((f) => f.id).filter((fid) => (fid === id ? e.target.checked : settings.fields.includes(fid)));
    saveSettings(); guarded(refreshTags);
  };
  $("selLang").onchange = (e) => { settings.lang = e.target.value; saveSettings(); guarded(refreshTags); };
  $("selLayout").onchange = (e) => { settings.layout = e.target.value; saveSettings(); guarded(refreshTags); };
  $("numSide").onchange = (e) => { const v = parseFloat(e.target.value); if (v >= 0) { settings.side = v; saveSettings(); guarded(refreshTags); } };
  $("numLift").onchange = (e) => { const v = parseFloat(e.target.value); if (v > 0) { settings.lift = v; saveSettings(); guarded(refreshTags); } };
  $("selUi").onchange = (e) => { ui = I18N ? I18N.setLang(e.target.value) : e.target.value; applyStatic(); renderFieldOptions(); render(); relabelStatus(); };
  applyStatic();
  renderFieldOptions();

  let reloadTimer = null;
  function onEvent(event, data) {
    if (tokenHelper) tokenHelper.onEvent(event, data);
    if (denied) return;
    // selection cleared in the viewer (e.g. click on empty space): the group chips are no longer selected
    if (event === "viewer.onSelectionChanged" && state.selPrefixes.size) {
      const sel = data && (data.data || data);
      const n = Array.isArray(sel) ? sel.reduce((k, m) => k + ((m && m.objectRuntimeIds) || []).length, 0) : -1;
      if (n === 0) { state.selPrefixes.clear(); render(); }
      return;
    }
    if (event === "viewer.onModelReset") {
      state.focusKey = null; state.focusTagAdded = false; state.coloured = false; $("chkColour").checked = false;
      render();
      return;
    }
    if (event === "viewer.onModelStateChanged" && state.api) {
      setStatus(L2("Моделите са променени, елементите се четат отново…", "Models changed, reading cast units again…"));
      clearTimeout(reloadTimer);
      reloadTimer = setTimeout(() => guarded(async () => {
        await removeTags([...state.tags.keys()]);
        await loadCastUnits();
        if (state.coloured) await applyColours();
      }), 1500);
    }
  }


  // ---------- access (shared/arsten-access.js): ADMIN or GENERAL CONTRACTOR group only ----------
  let tokenHelper = null, denied = false;
  async function gate(api) {
    if (window.ARSTEN_DEMO) return true;
    if (window.ArstenDiag) ArstenDiag.set({ panel: "Cast unit tags (castunit-tags)", lang: () => ui });   // round 19 M1: before the access check, so a denied screen's diagnostics name the panel
    tokenHelper = ArstenAccess.tokenGetter(api);
    setStatus(L2("Проверка на достъпа…", "Checking access…"));
    const access = await ArstenAccess.check({ api, getToken: tokenHelper.getToken, app: "execution" });
    if (access.allowed) return true;
    denied = true;
    ArstenAccess.renderDenied(document.body, ui, access);   // the interface language (A10; was the label language, round 11 L2)
    return false;
  }

  async function start(api) {
    if (I18N) { const l = await I18N.pickLang(api, null); if (l !== ui) { ui = l; applyStatic(); renderFieldOptions(); } }   // stored choice, else the Connect user's language
    if (!(await gate(api))) return;   // no data is read before access is confirmed
    state.api = api;
    // diagnostics: the interface language (not the tag language), and the signed-in user's name hidden (round 15 L3)
    if (window.ArstenDiag) Promise.resolve().then(async () => {
      let user = "";
      try { const u = await api.user.getUser(); user = (u && ([u.firstName, u.lastName].filter(Boolean).join(" ") || u.email)) || ""; } catch {}
      const p = await api.project.getProject();
      ArstenDiag.set({ panel: "Cast unit tags (castunit-tags)", projectId: p && p.id, redact: [user], lang: () => ui });
    }).catch(() => {});   // A23
    await guarded(loadCastUnits);
  }
  window.CastUnitTagsApp = { start, state };   // used by demo.js

  if (window.parent === window) {
    if (/[?&]demo\b/.test(location.search)) {
      const s = document.createElement("script"); s.src = "demo.js?t=" + Date.now(); document.body.appendChild(s);
    } else setStatus(I18N ? I18N.word("notInside", ui) : "Not inside Trimble Connect.", true);
    return;
  }
  if (I18N) setStatus(I18N.word("connecting", ui));
  TrimbleConnectWorkspace.connect(window.parent, onEvent, 30000)
    .then((api) => start(api))
    .catch((e) => setStatus((I18N ? I18N.word("connectFail", ui) : "Could not connect to Trimble Connect") + ": " + errText(e), true));
})();
