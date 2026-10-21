import { app } from "../../scripts/app.js";

/**
 * Switchboard - Group / Node Controllers
 * ---------------------------------------
 * Client-side ("virtual") nodes, in the spirit of rgthree's Fast Group Bypasser
 * but more flexible. Two node types share one base:
 *
 *   - Group Controller -- targets are GROUPS (by title).
 *   - Node Controller  -- targets are individual NODES (by id).
 *
 * For each target you get an on/off toggle (drivable by a wired BOOLEAN input)
 * plus an independent "disable as" bypass/mute selector, a master broadcast
 * toggle, and add/remove dropdowns.
 *
 * Enabling/disabling a target just changes the *mode* of the underlying node(s)
 * -- a pure graph operation, applied immediately on change and again at queue
 * time via applyToGraph() so the prompt that runs matches what you see.
 */

// LiteGraph node modes.
const MODE_ALWAYS = 0; // active / enabled
const MODE_NEVER = 2; // muted
const MODE_BYPASS = 4; // bypassed (route around)

const CATEGORY = "🎛️ Switchboard";
const DISABLE_MODES = ["bypass", "mute"];
// Recognised values from an older single tri-state shape, kept for migration.
const GROUP_STATES = ["enabled", "bypass", "mute"];
const MODE_WIDGET_LABEL = "↳ disable as";
const INVERT_WIDGET_LABEL = "⇄ input";

// Wired Controller patch. A custom socket type so a Wired Controller's output
// only connects to a Controller's patch input, plus the input slot label it
// lands on. ("Patch" as in patching a connection through a switchboard.)
const BUS_TYPE = "SWITCHBOARD_PATCH";
const BUS_INPUT_NAME = "↦ patch";

/** Resolve a control's LiteGraph node mode from its enabled flag + disable mode. */
function controlToMode(control) {
  if (control.enabled) return MODE_ALWAYS;
  return control.disableMode === "mute" ? MODE_NEVER : MODE_BYPASS;
}

// ---- group targets ---------------------------------------------------------

// NOTE: every helper takes the *node's own graph* (`this.graph`), not the root
// `app.graph`. A controller placed inside a subgraph must see that subgraph's
// groups/nodes/links -- using the root graph is what made subgraphs only list
// the outer graph's contents.

function getGraphGroups(graph) {
  if (!graph) return [];
  return graph._groups || graph.groups || [];
}

/** All group titles in `graph`, de-duplicated, as {key,label}. */
function getGroupChoices(graph) {
  const seen = new Set();
  const choices = [];
  for (const group of getGraphGroups(graph)) {
    if (group.title && !seen.has(group.title)) {
      seen.add(group.title);
      choices.push({ key: group.title, label: group.title });
    }
  }
  return choices;
}

/** A node's rect as [x, y, w, h], title bar included. `boundingRect` is only
 *  filled in when a node is *rendered*, so it reads [0,0,0,0] for every node in
 *  a graph that isn't currently on screen; pos/size are always valid, so derive
 *  the rect from those when the cached one is degenerate. */
function nodeRect(node) {
  const cached = node.boundingRect;
  if (cached && (cached[2] || cached[3])) return cached;
  const titleH = (typeof LiteGraph !== "undefined" && LiteGraph.NODE_TITLE_HEIGHT) || 30;
  const width = (node.size && node.size[0]) || 0;
  const height = node.flags && node.flags.collapsed ? 0 : (node.size && node.size[1]) || 0;
  return [node.pos[0], node.pos[1] - titleH, width, height + titleH];
}

/** litegraph's own containment rule: a node is in a group when the centre of
 *  its rect falls inside the group's bounding box. */
function groupContains(bounding, node) {
  const [x, y, w, h] = nodeRect(node);
  const cx = x + w / 2;
  const cy = y + h / 2;
  return (
    cx >= bounding[0] &&
    cx <= bounding[0] + bounding[2] &&
    cy >= bounding[1] &&
    cy <= bounding[1] + bounding[3]
  );
}

/** The nodes inside `group`, worked out ourselves rather than by asking
 *  litegraph. `group.recomputeInsideNodes()` matches on render-time bounding
 *  rects, so it returns an EMPTY set for any graph the user hasn't opened --
 *  e.g. a subgraph holding a Controller, which would then silently control
 *  nothing, queue time included. */
function nodesInGroup(graph, group) {
  const bounding = group._bounding || group.bounding;
  if (!bounding) return [];
  return getGraphNodes(graph).filter((node) => groupContains(bounding, node));
}

/** Set the mode of every node inside `graph` groups whose title matches `key`. */
function applyModeToGroup(graph, key, mode) {
  for (const group of getGraphGroups(graph)) {
    if (group.title !== key) continue;
    for (const node of nodesInGroup(graph, group)) node.mode = mode;
  }
}

// ---- tag targets ------------------------------------------------------------
//
// A tag spans nodes anywhere in the graph (unlike a Group's one title or a
// Node Controller's one id), so one Tag Controller target can bypass/mute an
// arbitrary, non-contiguous set of nodes at once -- handy in a complex graph
// where the "same switch" needs to reach nodes that aren't in one group.
// Tags live in `node.properties.switchboardTags` (array of strings), set via
// the "🎛️ Tag…" context-menu item added to every node below.

/** Read `node`'s Switchboard tags, tolerating a missing/malformed property. */
function nodeTags(node) {
  const tags = node && node.properties && node.properties.switchboardTags;
  return Array.isArray(tags) ? tags.filter((t) => typeof t === "string" && t) : [];
}

function setNodeTags(node, tags) {
  if (!node.properties) node.properties = {};
  node.properties.switchboardTags = [...new Set(tags)];
}

/** Every distinct tag present on any (non-controller) node in `graph`. */
function getTagChoices(graph) {
  const seen = new Set();
  const choices = [];
  for (const node of getGraphNodes(graph)) {
    if (node.constructor && node.constructor.isSwitchboardController) continue;
    for (const tag of nodeTags(node)) {
      if (!seen.has(tag)) {
        seen.add(tag);
        choices.push({ key: tag, label: tag });
      }
    }
  }
  return choices;
}

/** Set the mode of every node in `graph` carrying `tag`. */
function applyModeToTag(graph, tag, mode) {
  for (const node of getGraphNodes(graph)) {
    if (node.constructor && node.constructor.isSwitchboardController) continue;
    if (nodeTags(node).includes(tag)) node.mode = mode;
  }
}

// ---- node targets ----------------------------------------------------------

function getGraphNodes(graph) {
  if (!graph) return [];
  return graph._nodes || graph.nodes || [];
}

/** Every targetable node in `graph` as {key:id, label:"id: Title"}, excluding
 *  `self` and any of our own controller nodes (you can't control a controller). */
function getNodeChoices(graph, self) {
  const choices = [];
  for (const node of getGraphNodes(graph)) {
    if (node === self) continue;
    if (node.constructor && node.constructor.isSwitchboardController) continue;
    const name = node.title || node.type || "node";
    choices.push({ key: String(node.id), label: `${node.id}: ${name}` });
  }
  return choices;
}

/** Set the mode of the `graph` node whose id matches `key`. Handles both numeric
 *  ids (classic graphs) and string ids (e.g. subgraph nodes under Nodes 2.0). */
function applyModeToNode(graph, key, mode) {
  if (!graph || !graph.getNodeById) return;
  let node = graph.getNodeById(key);
  if (!node && /^\d+$/.test(key)) node = graph.getNodeById(Number(key));
  if (node) node.mode = mode;
}

/** Look up a link by id, tolerating both the classic object/array `links` and
 *  the newer `Map` used by the Comfy-Org litegraph (incl. Subgraph). */
function linkById(graph, id) {
  const links = graph && graph.links;
  if (!links || id == null) return null;
  if (typeof links.get === "function") return links.get(id) || null; // Map
  return links[id] || null; // object / array
}

/** Resolve a node by id, including subgraph I/O proxy nodes that aren't always
 *  registered in getNodeById. */
function nodeById(graph, id) {
  if (!graph) return null;
  let n = graph.getNodeById ? graph.getNodeById(id) : null;
  if (!n && /^\d+$/.test(String(id)) && graph.getNodeById) n = graph.getNodeById(Number(id));
  if (n) return n;
  const io = [];
  if (graph.inputNode) io.push(graph.inputNode);
  if (graph.outputNode) io.push(graph.outputNode);
  if (Array.isArray(graph._input_nodes)) io.push(...graph._input_nodes);
  if (Array.isArray(graph._output_nodes)) io.push(...graph._output_nodes);
  for (const c of io) if (c && (c.id === id || c.id === Number(id))) return c;
  return null;
}

// ---- boolean resolution (shared) -------------------------------------------
//
// These are module functions (not methods) because both the Controllers and the
// Wired Controller resolve booleans the same way: follow a wire to its source,
// reading a constant on the front-end, and hopping across a subgraph boundary
// when the source is a subgraph input proxy. The reliable operation is reading
// in the node's OWN graph; cross-boundary hops are best-effort.

/** The widget on `node` most likely to hold a boolean constant. */
function boolWidgetOf(node) {
  const widgets = (node && node.widgets) || [];
  let w = widgets.find((x) => typeof x.value === "boolean");
  if (!w) w = widgets.find((x) => /^(value|boolean|bool)$/i.test(x.name || ""));
  return w || null;
}

/** The input slot backing `widget` on `node` -- the slot a widget-input link
 *  lands on when the widget is driven by a wire instead of typed in. */
function widgetInputSlot(node, widget) {
  if (!node || !widget) return null;
  for (const input of node.inputs || []) {
    if (input && input.widget && input.widget.name === widget.name) return input;
  }
  return null;
}

/** If `node`'s boolean widget is fed by a wire, the id of that link. Since
 *  ComfyUI's subgraph *widget promotion*, a driven widget's own `value` is
 *  never written back -- the live value sits upstream (on the promoting node),
 *  so the wire has to be followed rather than the stale local value read. */
function widgetInputLink(node) {
  const input = widgetInputSlot(node, boolWidgetOf(node));
  return input && input.link != null ? input.link : null;
}

/** Read a boolean constant off a node, or its cached output value. Returns null
 *  for a widget that's driven by a wire -- see `widgetInputLink`. */
function readBoolWidget(node, originSlot) {
  const w = boolWidgetOf(node);
  if (w) return widgetInputLink(node) != null ? null : !!w.value;
  const out = node.outputs?.[originSlot];
  if (out && typeof out._data !== "undefined") return !!out._data;
  return null;
}

/** Resolve the inner graph hosted by a subgraph-instance node, tolerating the
 *  several shapes litegraph versions use (direct ref, registry by uuid). */
function subgraphOf(node) {
  if (!node) return null;
  if (node.subgraph) return node.subgraph;
  if (node._subgraph) return node._subgraph;
  const root = (node.graph && node.graph._rootGraph) || app.graph;
  const reg = root && (root._subgraphs || root.subgraphs);
  if (reg && typeof reg.get === "function") {
    const id = node.subgraphId || node.type || node.properties?.subgraph;
    const sub = id != null ? reg.get(id) : null;
    if (sub) return sub._graph || sub.graph || sub;
  }
  return null;
}

/** The id of the subgraph a node instantiates (its uuid), tolerating shapes. */
function subgraphIdOf(node) {
  if (!node) return null;
  if (node.subgraph && node.subgraph.id != null) return node.subgraph.id;
  return node.subgraphId || node.properties?.subgraph || node.type || null;
}

/** Find the subgraph-instance node (in some parent graph) that hosts `graph`,
 *  i.e. the node you'd see in the parent whose inner graph IS `graph`. Matches
 *  by object identity AND by subgraph id (more robust across litegraph versions),
 *  searching from the root and any known root reference. */
function findSubgraphHost(graph) {
  if (!graph) return { host: null, parentGraph: null };
  const direct = graph._subgraph_node || graph.subgraphNode || graph._node || null;
  if (direct) return { host: direct, parentGraph: direct.graph };

  const wantId = graph.id;
  const roots = [];
  if (app.graph) roots.push(app.graph);
  if (graph._rootGraph && !roots.includes(graph._rootGraph)) roots.push(graph._rootGraph);
  const stack = [...roots];
  const seen = new Set();
  while (stack.length) {
    const g = stack.pop();
    if (!g || seen.has(g)) continue;
    seen.add(g);
    for (const n of g._nodes || g.nodes || []) {
      const sub = subgraphOf(n);
      if (sub === graph || (wantId != null && subgraphIdOf(n) === wantId)) {
        return { host: n, parentGraph: g };
      }
      if (sub && !seen.has(sub)) stack.push(sub);
    }
  }
  return { host: null, parentGraph: null };
}

/** Every link id leaving `node`'s output `slot`. Gathered robustly: the slot's
 *  own `links`/`_floatingLinks`, plus a scan of the graph's link collection
 *  (covers versions where the slot array isn't maintained the way we expect). */
function outgoingLinkIds(graph, node, slot) {
  const ids = new Set();
  const out = node.outputs?.[slot];
  if (out) {
    if (Array.isArray(out.links)) for (const id of out.links) if (id != null) ids.add(id);
    if (Array.isArray(out._floatingLinks)) {
      for (const fl of out._floatingLinks) {
        const id = fl && (fl.id != null ? fl.id : fl);
        if (id != null) ids.add(id);
      }
    }
  }
  const links = graph && graph.links;
  if (links) {
    const all = typeof links.values === "function" ? links.values() : Object.values(links);
    for (const link of all) {
      if (link && link.origin_id === node.id && link.origin_slot === slot && link.id != null) {
        ids.add(link.id);
      }
    }
  }
  return [...ids];
}

/** Which of `graph`'s subgraph outputs does `node`/`slot` feed? Returns the
 *  output indices, read from the output proxy's input links and the subgraph's
 *  own `outputs[]` link records -- whichever the running litegraph populates. */
function subgraphOutputsFedBy(graph, node, slot) {
  const res = new Set();
  const proxy = graph.outputNode || graph._outputNode || graph.output_node;
  if (proxy && Array.isArray(proxy.inputs)) {
    for (let k = 0; k < proxy.inputs.length; k++) {
      const linkId = proxy.inputs[k]?.link;
      if (linkId == null) continue;
      const link = linkById(graph, linkId);
      if (link && link.origin_id === node.id && link.origin_slot === slot) res.add(k);
    }
  }
  if (Array.isArray(graph.outputs)) {
    for (let k = 0; k < graph.outputs.length; k++) {
      const o = graph.outputs[k];
      if (!o) continue;
      const ids = [];
      if (o.link != null) ids.push(o.link);
      if (Array.isArray(o.linkIds)) ids.push(...o.linkIds);
      if (Array.isArray(o._floatingLinks)) {
        for (const fl of o._floatingLinks) {
          const id = fl && (fl.id != null ? fl.id : fl);
          if (id != null) ids.push(id);
        }
      }
      for (const id of ids) {
        const link = linkById(graph, id);
        if (link && link.origin_id === node.id && link.origin_slot === slot) res.add(k);
      }
    }
  }
  return [...res];
}

/** If `origin` is `graph`'s subgraph-input proxy node, hop out to the parent.
 *  Returns `{graph, linkId}` when the matching input on the subgraph instance
 *  node is wired, or `{value}` when that input is instead exposed as a promoted
 *  widget on the instance (which holds the value itself -- no link to follow). */
function crossSubgraphInput(graph, origin, originSlot) {
  try {
    const inputProxy = graph.inputNode || graph._inputNode || graph.input_node;
    if (!inputProxy || origin !== inputProxy) return null;
    const { host, parentGraph } = findSubgraphHost(graph);
    if (!host || !parentGraph) return null;
    const parentInput = host.inputs?.[originSlot];
    if (!parentInput) return null;
    if (parentInput.link != null) return { graph: parentGraph, linkId: parentInput.link };
    const promoted = parentInput.widget
      ? (host.widgets || []).find((w) => w.name === parentInput.widget.name)
      : null;
    if (promoted && typeof promoted.value === "boolean") return { value: !!promoted.value };
    return null;
  } catch (err) {
    console.debug("[Switchboard] subgraph input crossing error", err);
    return null;
  }
}

/** Walking an OUTPUT outward: if `target` is `graph`'s subgraph-output proxy
 *  node, return the parent graph + the host node + the matching output slot, so
 *  a walk can continue following the host's external output links. This is the
 *  child->parent direction, which (unlike descending into a child) is reliable. */
function crossOutputToParent(graph, target, targetSlot) {
  try {
    const outputProxy = graph.outputNode || graph._outputNode || graph.output_node;
    if (!outputProxy || target !== outputProxy) return null;
    const { host, parentGraph } = findSubgraphHost(graph);
    if (!host || !parentGraph) return null;
    return { graph: parentGraph, node: host, slot: targetSlot };
  } catch (err) {
    console.debug("[Switchboard] subgraph output crossing error", err);
    return null;
  }
}

/** Walking an OUTPUT into a child: if `target` is a subgraph INSTANCE node and a
 *  link lands on its input `targetSlot`, descend into the inner graph and return
 *  its input proxy + matching output slot, so the walk continues toward whatever
 *  that subgraph input drives inside. (Reaching a sibling subgraph's contents.) */
function crossInputToChild(target, targetSlot) {
  try {
    const sub = subgraphOf(target);
    if (!sub) return null;
    const inputProxy = sub.inputNode || sub._inputNode || sub.input_node;
    if (!inputProxy) return null;
    return { graph: sub, node: inputProxy, slot: targetSlot };
  } catch (err) {
    console.debug("[Switchboard] subgraph input descend error", err);
    return null;
  }
}

/** A Group/Node Controller that can receive bus signals (not a Wired Controller). */
function isReceivingController(node) {
  const c = node && node.constructor;
  return !!(c && c.isSwitchboardController && !c.isWiredController);
}

/** If `origin` is a subgraph INSTANCE node and we tapped its output `originSlot`,
 *  descend into the inner graph and return the internal link feeding that output
 *  (which leads to whatever drives it inside the subgraph). */
function crossSubgraphOutput(origin, originSlot) {
  try {
    const sub = subgraphOf(origin);
    if (!sub) return null;
    const out = (sub.outputs && sub.outputs[originSlot]) || null;
    if (!out) return null;
    let linkId = out.link;
    if (linkId == null && Array.isArray(out.linkIds)) linkId = out.linkIds[0];
    if (linkId == null && Array.isArray(out._floatingLinks) && out._floatingLinks[0]) {
      linkId = out._floatingLinks[0].id;
    }
    if (linkId == null) return null;
    return { graph: sub, linkId };
  } catch (err) {
    console.debug("[Switchboard] subgraph output crossing error", err);
    return null;
  }
}

/** Follow `linkId` in `graph` to a usable boolean. Returns true/false or null. */
function resolveBoolean(graph, linkId, depth) {
  if (!graph || linkId == null || depth > 10) return null;
  const link = linkById(graph, linkId);
  if (!link) return null;
  const origin = nodeById(graph, link.origin_id);
  if (!origin) return null;

  // 1) Source is a subgraph INSTANCE node -> descend to whatever drives its
  //    output. Tried first because such a node's widgets are *promoted* inner
  //    widgets that have nothing to do with the output slot we tapped, so
  //    reading one off it would pick an unrelated boolean.
  const down = crossSubgraphOutput(origin, link.origin_slot);
  if (down) {
    const inner = resolveBoolean(down.graph, down.linkId, depth + 1);
    if (inner !== null) return inner;
  }

  // 2) A constant boolean we can read directly on the front-end.
  const direct = readBoolWidget(origin, link.origin_slot);
  if (direct !== null) return direct;

  // 3) The constant's widget is driven by a wire (a promoted or converted
  //    widget input) -> follow that wire; the local value is stale.
  const viaWidget = widgetInputLink(origin);
  if (viaWidget != null) return resolveBoolean(graph, viaWidget, depth + 1);

  // 4) Source is a subgraph INPUT proxy -> hop out to the parent and keep going,
  //    or read the promoted widget standing in for an unwired input.
  const up = crossSubgraphInput(graph, origin, link.origin_slot);
  if (up) {
    if (typeof up.value === "boolean") return up.value;
    if (up.linkId != null) return resolveBoolean(up.graph, up.linkId, depth + 1);
  }

  return null;
}

// ---- Wired Controller bus --------------------------------------------------
//
// Pub/sub registry keyed by channel name. This is the robust transport that
// needs NO cross-boundary graph traversal: a Wired Controller reads its booleans
// in its OWN graph (always reliable) and writes the resolved {label:bool} map
// here under a string key; receivers read by the same key. The wire (a
// SWITCHBOARD_BUS socket) is the convenient binding when link-traversal works;
// the channel name is the always-works fallback when it doesn't.

const SwitchboardBus = {
  channels: new Map(), // channel name -> { label: bool }  (Wired Controller -> Controllers)
  demands: new Map(), // channel name -> Map(sourceKey -> { labels:[], ts }) (Controllers -> Wired Controller)
  publish(channel, signals) {
    if (channel) this.channels.set(channel, signals);
  },
  read(channel) {
    return channel ? this.channels.get(channel) || null : null;
  },
  // A Controller advertises the target labels it wants driven, by channel. The
  // Wired Controller reads the union to auto-create matching signals. Entries are
  // timestamped so a Controller that disconnects (or changes channel) ages out.
  demand(channel, sourceKey, labels, now) {
    if (!channel) return;
    let m = this.demands.get(channel);
    if (!m) {
      m = new Map();
      this.demands.set(channel, m);
    }
    m.set(sourceKey, { labels: labels.slice(), ts: now });
  },
  demandedLabels(channel, now) {
    const m = channel ? this.demands.get(channel) : null;
    if (!m) return [];
    const out = new Set();
    for (const [key, entry] of [...m]) {
      if (now - entry.ts > 1000) {
        m.delete(key); // stale: source stopped advertising on this channel
        continue;
      }
      for (const label of entry.labels) out.add(label);
    }
    return [...out];
  },
};

/** Look up a signal in a {label:bool} map, exact first then case/space-tolerant. */
function busValueFor(signals, label) {
  if (!signals || label == null) return null;
  if (Object.prototype.hasOwnProperty.call(signals, label)) return !!signals[label];
  const norm = (s) => String(s).trim().toLowerCase();
  const want = norm(label);
  for (const key of Object.keys(signals)) {
    if (norm(key) === want) return !!signals[key];
  }
  return null;
}

/**
 * Shared base. Subclasses provide three things via static/overridable members:
 *   - static targetWord          ("group" | "node") for placeholder text
 *   - _allChoices()  -> [{key,label}] of everything targetable right now
 *   - _applyTo(key, mode)        applies a LiteGraph mode to that target
 */
class BaseControllerNode extends LGraphNode {
  constructor(title) {
    super(title);

    // Virtual: never sent to the server as an executable node.
    this.isVirtualNode = true;
    // All state lives in `this.properties` (serialized automatically). Widgets
    // are rebuilt from properties on load, so don't also persist widget values.
    this.serialize_widgets = false;

    if (!this.properties) this.properties = {};
    // controls: array of { key, label, enabled: bool, disableMode: bypass|mute }
    if (!this.properties.controls) this.properties.controls = [];
    this._normalizeControls();

    this.size = [260, 120];
    this._buildWidgets();
  }

  get _addPlaceholder() {
    return `➕ Add ${this.constructor.targetWord}…`;
  }

  get _removePlaceholder() {
    return `➖ Remove ${this.constructor.targetWord}…`;
  }

  /** The graph this controller lives in -- the subgraph when nested, otherwise
   *  the root graph. Everything operates on this, never the root `app.graph`. */
  _graph() {
    return this.graph || app.graph;
  }

  // ---- overridable target hooks (defaults are inert) -----------------------

  _allChoices() {
    return [];
  }

  _applyTo(_key, _mode) {}

  // ---- migration / setup ---------------------------------------------------

  /** Backfill defaults and migrate older shapes so saved workflows keep working.
   *  Target shape: { key, label, enabled, disableMode }. */
  _normalizeControls() {
    for (const c of this.properties.controls) {
      // Old Group Controller shape used `title` for both key and label.
      if (c.key == null && c.title != null) c.key = c.title;
      if (c.label == null) c.label = c.title != null ? c.title : c.key;
      if (!DISABLE_MODES.includes(c.disableMode)) c.disableMode = "bypass";
      if (typeof c.enabled !== "boolean") {
        // Migrate from the single tri-state { state } shape.
        if (GROUP_STATES.includes(c.state)) {
          c.enabled = c.state === "enabled";
          if (c.state !== "enabled") c.disableMode = c.state;
        } else {
          c.enabled = true;
        }
      }
      if (typeof c.invert !== "boolean") c.invert = false;
      delete c.state;
      delete c.title;
    }
  }

  _availableChoices() {
    const used = new Set(this.properties.controls.map((c) => c.key));
    return this._allChoices().filter((choice) => !used.has(choice.key));
  }

  // ---- widget construction -------------------------------------------------

  _buildWidgets() {
    this.widgets = [];

    // 1) Master broadcast: clicking it forces every target on/off. It does NOT
    //    track individual or boolean-driven changes -- it's an action switch.
    //    When disabling, each target uses its own bypass/mute mode.
    this.addWidget(
      "toggle",
      "ALL",
      this._allEnabled(),
      (value) => {
        const signals = this._resolveBusSignals();
        for (const control of this.properties.controls) {
          // A connected input (direct boolean or Wired Controller signal) governs
          // its target -- the master broadcast / manual toggling is overridden by
          // it, so skip those here.
          if (this._isGoverned(control, signals)) continue;
          control.enabled = value;
        }
        this._syncToggles();
        this.applyAll();
      },
      { on: "enabled", off: "disabled" },
    );

    // 1b) Optional Wired Controller channel. Leave blank to bind only by wire
    //     (or not at all); set it to the channel a Wired Controller publishes on
    //     to follow it by name -- works across any subgraph nesting.
    this.addWidget(
      "text",
      "channel",
      this.properties.busChannel || "",
      (value) => {
        this.properties.busChannel = (value || "").trim();
        this._pollInputs();
      },
      {},
    );

    // 2) Per target: a divider line, then on/off toggle (boolean-driven) +
    //    "disable as" + invert. The divider keeps each target's three rows from
    //    blurring into the next group's (and separates them from the header).
    for (const control of this.properties.controls) {
      this._addDivider();
      this._addControlWidgets(control);
    }
    // Close the last group off so the add/remove controls read as their own row.
    if (this.properties.controls.length) this._addDivider();

    // 3) "Add" combo -- lists targets not yet controlled.
    this.addWidget(
      "combo",
      "add",
      this._addPlaceholder,
      (value) => {
        const choice = this._availableChoices().find((c) => c.label === value);
        if (choice) this.addTarget(choice.key, choice.label);
      },
      { values: () => [this._addPlaceholder, ...this._availableChoices().map((c) => c.label)] },
    );

    // 4) "Remove" combo -- only when there's something to remove.
    if (this.properties.controls.length) {
      this.addWidget(
        "combo",
        "remove",
        this._removePlaceholder,
        (value) => {
          const control = this.properties.controls.find((c) => c.label === value);
          if (control) this.removeTarget(control.key);
        },
        { values: () => [this._removePlaceholder, ...this.properties.controls.map((c) => c.label)] },
      );
    }

    this._refreshAddWidget();
    this._syncInputs();
    // Grow to fit the widgets (e.g. the per-target invert row on saved nodes).
    if (this.properties.controls.length) {
      this.size[1] = Math.max(this.size[1], this.computeSize()[1]);
    }
    this.setDirtyCanvas(true, true);
  }

  /** A thin horizontal separator widget pushed between target groups. It's a
   *  custom draw-only widget: it renders a line on the legacy canvas and is
   *  inert/non-interactive. (Under the Nodes 2.0 / Vue renderer custom draws
   *  aren't shown, so it simply collapses to a small gap there -- harmless.) */
  _addDivider() {
    const widget = {
      type: "switchboard_divider",
      name: "",
      value: "",
      // Slim row; LiteGraph uses this to allocate height.
      computeSize(width) {
        return [width, 8];
      },
      draw(ctx, node, width, y, H) {
        const margin = 10;
        const lineY = Math.round(y + H * 0.5) + 0.5;
        ctx.save();
        ctx.strokeStyle = LiteGraph.WIDGET_OUTLINE_COLOR || "rgba(255,255,255,0.2)";
        ctx.globalAlpha = 0.5;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(margin, lineY);
        ctx.lineTo(width - margin, lineY);
        ctx.stroke();
        ctx.restore();
      },
    };
    this.widgets.push(widget);
    return widget;
  }

  _addControlWidgets(control) {
    // On/off toggle -- this is what a wired BOOLEAN input drives.
    const toggle = this.addWidget(
      "toggle",
      control.label,
      control.enabled,
      (value) => {
        control.enabled = value;
        this.applyControl(control);
      },
      { on: "enabled", off: "disabled" },
    );
    toggle._controlKey = control.key;

    // Independent "disable as" selector -- stays editable even while a boolean
    // holds the target enabled, so you can pre-set bypass vs mute per target.
    this.addWidget(
      "combo",
      MODE_WIDGET_LABEL,
      control.disableMode,
      (value) => {
        control.disableMode = value;
        this.applyControl(control); // re-applies immediately if currently disabled
      },
      { values: DISABLE_MODES },
    );

    // Per-target input inversion -- flips the value coming from a wired boolean
    // or a Wired Controller patch signal, so one input can drive two targets to
    // OPPOSITE states (e.g. group A on while group B off). No effect on a
    // manually-toggled target (there's no input to invert). NOTE: no _controlKey,
    // so _syncToggles() leaves this user setting alone.
    this.addWidget(
      "toggle",
      INVERT_WIDGET_LABEL,
      !!control.invert,
      (value) => {
        control.invert = value;
        this._pollInputs(); // re-read inputs so the (inverted) value applies now
      },
      { on: "inverted", off: "normal" },
    );
  }

  // ---- helpers -------------------------------------------------------------

  _allEnabled() {
    const controls = this.properties.controls;
    return controls.length > 0 && controls.every((c) => c.enabled);
  }

  _syncToggles() {
    // Only the on/off toggles mirror state; the "disable as" combos are
    // user-owned and never driven by inputs, so they're left alone.
    for (const control of this.properties.controls) {
      const widget = this.widgets?.find((w) => w._controlKey === control.key);
      if (widget) widget.value = control.enabled;
    }
  }

  _refreshAddWidget() {
    const addWidget = this.widgets?.find((w) => w.name === "add");
    if (addWidget) addWidget.value = this._addPlaceholder;
  }

  // ---- boolean inputs ------------------------------------------------------

  /** Ensure exactly one BOOLEAN input per control, matched by label. Reconciles
   *  by name so existing slots (and their links) survive reload. */
  _syncInputs() {
    const wanted = this.properties.controls.map((c) => c.label);
    for (let i = (this.inputs?.length || 0) - 1; i >= 0; i--) {
      const name = this.inputs[i].name;
      if (name === BUS_INPUT_NAME) continue; // keep the Wired Controller bus input
      if (!wanted.includes(name)) this.removeInput(i);
    }
    // One bus input so a Wired Controller can be wired straight in.
    if (this.findInputSlot(BUS_INPUT_NAME) === -1) this.addInput(BUS_INPUT_NAME, BUS_TYPE);
    for (const label of wanted) {
      if (this.findInputSlot(label) === -1) this.addInput(label, "BOOLEAN");
    }
  }

  /** Read the boolean coming into `slot`. Follows the wire to its source,
   *  hopping across subgraph boundaries as needed. true/false, or null if
   *  nothing usable is connected. */
  _readBooleanInput(slot) {
    const input = this.inputs?.[slot];
    if (!input || input.link == null) return null;
    return resolveBoolean(this._graph(), input.link, 0);
  }

  /** A bound Wired Controller pushes its resolved signals onto us (over the wire,
   *  reaching across subgraph boundaries in the reliable child->parent direction).
   *  Stored per source so several Wired Controllers can fan in. */
  _receivePushedSignals(sourceKey, signals) {
    if (!this._pushed) this._pushed = new Map();
    this._pushed.set(sourceKey, { signals, ts: Date.now() });
  }

  /** Resolve the {label:bool} signal map driving this controller: the union of
   *  every fresh pushed map (by wire) plus the subscribed channel. null when
   *  nothing is connected. Pushed (wire) values win over the channel on conflict. */
  _resolveBusSignals() {
    const now = Date.now();
    let merged = null;
    const channel = SwitchboardBus.read(this.properties.busChannel);
    if (channel) merged = Object.assign({}, channel);
    if (this._pushed) {
      for (const [key, entry] of [...this._pushed]) {
        if (now - entry.ts > 1000) {
          this._pushed.delete(key); // source stopped pushing -> drop it
          continue;
        }
        merged = Object.assign(merged || {}, entry.signals);
      }
    }
    return merged && Object.keys(merged).length ? merged : null;
  }

  /** Stable per-session key identifying this controller as a demand source. */
  _busKey() {
    if (!this.__busKey) this.__busKey = `${this.id}:${Math.floor(Math.random() * 1e9)}`;
    return this.__busKey;
  }

  /** Advertise our target labels on the channel so a Wired Controller bound only
   *  by name (no resolvable wire) can still auto-create matching signals. Wire
   *  binding needs nothing here -- the Wired Controller pulls our labels directly. */
  _advertiseToBus() {
    if (!this.properties.busChannel) return;
    const labels = this.properties.controls.map((c) => c.label);
    SwitchboardBus.demand(this.properties.busChannel, this._busKey(), labels, Date.now());
  }

  /** True when a Wired Controller bus signal covers this control's label. */
  _busGoverns(control, signals) {
    const sig = signals !== undefined ? signals : this._resolveBusSignals();
    return busValueFor(sig, control.label) !== null;
  }

  /** True when this control has a direct BOOLEAN wired in. */
  _hasBooleanInput(control) {
    const slot = this.findInputSlot(control.label);
    if (slot === -1) return false;
    const input = this.inputs?.[slot];
    return !!(input && input.link != null);
  }

  /** True when the target is driven by an input (direct boolean or bus signal)
   *  and so should ignore the master broadcast / manual toggling. */
  _isGoverned(control, signals) {
    return this._hasBooleanInput(control) || this._busGoverns(control, signals);
  }

  /** Pull every connected input into its control's enabled state. A bus signal
   *  (by label) drives the target; a direct per-target boolean overrides it. */
  _refreshFromInputs() {
    let changed = false;
    const bus = this._resolveBusSignals();
    for (const control of this.properties.controls) {
      let value = null;
      // 1) Wired Controller signal, matched by label.
      const fromBus = busValueFor(bus, control.label);
      if (fromBus !== null) value = fromBus;
      // 2) A direct boolean on the target's own socket wins over the bus.
      const slot = this.findInputSlot(control.label);
      if (slot !== -1) {
        const direct = this._readBooleanInput(slot);
        if (direct !== null) value = direct;
      }
      if (value === null) continue; // unwired -> leave manual toggle alone
      if (control.invert) value = !value; // flip this target relative to the input
      // Inputs drive only on/off; the target keeps its own disable mode.
      if (control.enabled !== value) {
        control.enabled = value;
        changed = true;
      }
    }
    if (changed) this._syncToggles();
    return changed;
  }

  _pollInputs() {
    this._advertiseToBus();
    if (this._refreshFromInputs()) {
      this.applyAll();
      this.setDirtyCanvas(true, true);
    }
  }

  // ---- public actions ------------------------------------------------------

  addTarget(key, label) {
    if (this.properties.controls.some((c) => c.key === key)) return;
    const control = { key, label, enabled: true, disableMode: "bypass", invert: false };
    this.properties.controls.push(control);
    // Rebuild so the toggle + disable-as combo, BOOLEAN input and "remove" combo
    // all appear at once. _buildWidgets() -> _syncInputs() adds the input slot.
    this._buildWidgets();
    this.applyControl(control);
    this.size[1] = Math.max(this.size[1], this.computeSize()[1]);
    this.setDirtyCanvas(true, true);
  }

  removeTarget(key) {
    const control = this.properties.controls.find((c) => c.key === key);
    this.properties.controls = this.properties.controls.filter((c) => c.key !== key);
    // Re-enable the target so removing the controller doesn't strand it disabled.
    if (control) this._applyTo(key, MODE_ALWAYS);
    this._buildWidgets();
  }

  applyControl(control) {
    this._applyTo(control.key, controlToMode(control));
    this.setDirtyCanvas(true, true);
  }

  applyAll() {
    for (const control of this.properties.controls) this.applyControl(control);
  }

  // ---- ComfyUI / LiteGraph hooks ------------------------------------------

  /** Called by ComfyUI during graphToPrompt (queue time). Re-reads any wired
   *  boolean inputs, then ensures the running graph matches the toggles. */
  applyToGraph() {
    this._refreshFromInputs();
    this.applyAll();
  }

  onAdded() {
    this.applyAll();
    // Live-track wired boolean inputs with a lightweight timer instead of a
    // canvas draw hook. Draw-based hooks (onDrawForeground) don't fire under the
    // Nodes 2.0 / Vue renderer; a timer works in both the legacy canvas and Vue.
    if (!this._pollTimer) {
      this._pollTimer = setInterval(() => this._pollInputs(), 200);
    }
  }

  onRemoved() {
    if (this._pollTimer) {
      clearInterval(this._pollTimer);
      this._pollTimer = null;
    }
  }

  onConfigure() {
    if (!this.properties.controls) this.properties.controls = [];
    this._normalizeControls();
    this._buildWidgets();
    // Defer applying until the rest of the graph (groups/nodes) exists.
    setTimeout(() => {
      this._refreshFromInputs();
      this.applyAll();
    }, 0);
  }

  /** Connecting/disconnecting a boolean input takes effect immediately. */
  onConnectionsChange(type) {
    if (type === LiteGraph.INPUT) this._pollInputs();
  }

  getExtraMenuOptions(_, options) {
    // IMPORTANT: push into `options` and DO NOT return it. ComfyUI's LiteGraph
    // does `options = extra.concat(options)` when this returns truthy -- returning
    // the mutated array would duplicate the ENTIRE context menu.
    const word = this.constructor.targetWord;
    if (this.properties.controls.length) {
      options.push({
        content: `Remove controlled ${word}`,
        has_submenu: true,
        submenu: {
          options: this.properties.controls.map((c) => ({
            content: c.label,
            callback: () => this.removeTarget(c.key),
          })),
        },
      });
    }
    options.push({
      content: `Refresh ${word} list`,
      callback: () => this._buildWidgets(),
    });
    options.push({
      content: "Log Switchboard diagnostics (console)",
      callback: () => this._logDiagnostics(),
    });
  }

  /** Dump everything needed to diagnose targeting / boolean-crossing issues.
   *  Open the browser console (F12) and copy the printed object. */
  _logDiagnostics() {
    const graph = this._graph();
    const isNode = this.constructor.targetWord === "node";
    const info = {
      node: this.constructor.nodeTitle,
      inRootGraph: graph === app.graph,
      graphCtor: graph && graph.constructor ? graph.constructor.name : null,
      graphKeys: graph ? Object.keys(graph) : [],
      subgraphInputNodeProp:
        (graph && graph.inputNode && "inputNode") ||
        (graph && graph._inputNode && "_inputNode") ||
        (graph && graph.input_node && "input_node") ||
        null,
      busChannel: this.properties.busChannel || "",
      busSignals: this._resolveBusSignals(),
      controls: [],
    };
    for (const c of this.properties.controls) {
      const slot = this.findInputSlot(c.label);
      const input = slot >= 0 ? this.inputs?.[slot] : null;
      const linkId = input ? input.link : null;
      let origin = null;
      const link = linkId != null ? linkById(graph, linkId) : null;
      if (link) {
        const o = nodeById(graph, link.origin_id);
        if (o) {
          origin = {
            id: o.id,
            type: o.type,
            ctor: o.constructor ? o.constructor.name : null,
            title: o.title,
            isVirtualNode: o.isVirtualNode,
            keys: Object.keys(o),
            widgets: (o.widgets || []).map((w) => ({ name: w.name, value: w.value })),
            isGraphInputNode: !!(
              graph &&
              (o === graph.inputNode || o === graph._inputNode || o === graph.input_node)
            ),
          };
        }
      }
      let targetFound;
      if (isNode) {
        targetFound = !!(
          graph?.getNodeById?.(c.key) ||
          (/^\d+$/.test(c.key) ? graph?.getNodeById?.(Number(c.key)) : null)
        );
      } else {
        targetFound = getGraphGroups(graph).some((g) => g.title === c.key);
      }
      info.controls.push({
        key: c.key,
        label: c.label,
        enabled: c.enabled,
        targetFoundInThisGraph: targetFound,
        inputSlot: slot,
        hasLink: linkId != null,
        booleanResolved: linkId != null ? this._readBooleanInput(slot) : null,
        busValue: busValueFor(info.busSignals, c.label),
        origin,
      });
    }
    console.log("[Switchboard] DIAGNOSTICS - copy this:", info);
    return info;
  }
}

// ---- concrete controllers --------------------------------------------------

class GroupControllerNode extends BaseControllerNode {
  static targetWord = "group";
  static isSwitchboardController = true;

  constructor(title = GroupControllerNode.nodeTitle) {
    super(title);
  }

  _allChoices() {
    return getGroupChoices(this._graph());
  }

  _applyTo(key, mode) {
    applyModeToGroup(this._graph(), key, mode);
  }
}
GroupControllerNode.nodeTitle = "Group Controller";

class NodeControllerNode extends BaseControllerNode {
  static targetWord = "node";
  static isSwitchboardController = true;

  constructor(title = NodeControllerNode.nodeTitle) {
    super(title);
  }

  _allChoices() {
    return getNodeChoices(this._graph(), this);
  }

  _applyTo(key, mode) {
    applyModeToNode(this._graph(), key, mode);
  }
}
NodeControllerNode.nodeTitle = "Node Controller";

class TagControllerNode extends BaseControllerNode {
  static targetWord = "tag";
  static isSwitchboardController = true;

  constructor(title = TagControllerNode.nodeTitle) {
    super(title);
  }

  _allChoices() {
    return getTagChoices(this._graph());
  }

  _applyTo(key, mode) {
    applyModeToTag(this._graph(), key, mode);
  }
}
TagControllerNode.nodeTitle = "Tag Controller";

// ---- Wired Controller (source) ---------------------------------------------

/**
 * Wired Controller -- a *source* that lives next to your booleans (typically
 * inside a subgraph) and relays them to one or more Group/Node Controllers.
 *
 * It reads each of its boolean inputs in its OWN graph (the reliable operation),
 * caches the resolved {label:bool} map, and makes it available two ways:
 *   - on its `patch` output, so you can wire it across subgraph IO into a
 *     Controller's bus input (the wire is followed back to this node's cache);
 *   - on a named `channel`, published to a global registry a Controller can
 *     subscribe to by name -- no cross-boundary wiring needed at all.
 *
 * A receiving Controller applies each signal to the target whose label matches.
 * One Wired Controller can fan out to many Controllers. This keeps a subgraph
 * tidy: just the booleans + one Wired Controller, with the actual targets held
 * by Controllers out in the parent graph.
 */
class WiredControllerNode extends LGraphNode {
  static nodeTitle = "Wired Controller";
  static isSwitchboardController = true; // Controllers won't target our own nodes
  static isWiredController = true;

  constructor(title = WiredControllerNode.nodeTitle) {
    super(title);
    this.isVirtualNode = true;
    this.serialize_widgets = false;

    if (!this.properties) this.properties = {};
    if (typeof this.properties.channel !== "string") this.properties.channel = "";
    // signals: array of { label } -- one boolean input each, matched on receivers.
    if (!Array.isArray(this.properties.signals)) this.properties.signals = [];

    this._signals = {}; // resolved cache {label:bool}, kept fresh by the timer
    this.size = [240, 110];

    this._ensurePatchOutput();
    this._buildWidgets();
  }

  _graph() {
    return this.graph || app.graph;
  }

  /** Ensure the single output is the patch bus, normalising nodes saved before
   *  the rename (output was "signals" / type "SWITCHBOARD_BUS"). */
  _ensurePatchOutput() {
    if (!this.outputs || !this.outputs.length) {
      this.addOutput("patch", BUS_TYPE);
      return;
    }
    const out = this.outputs[0];
    out.name = "patch";
    out.type = BUS_TYPE;
    delete out.label; // drop any stale display label so `name` shows
  }

  _buildWidgets() {
    this.widgets = [];

    // The channel this node publishes on (optional -- wiring works without it).
    this.addWidget(
      "text",
      "channel",
      this.properties.channel,
      (value) => {
        this.properties.channel = (value || "").trim();
      },
      {},
    );

    // One read-only-ish readout per signal: reflects the resolved boolean. It's
    // input-driven, so clicking just reverts on the next poll. Signals are added
    // and removed automatically to mirror the Controllers this node feeds.
    for (const signal of this.properties.signals) {
      const w = this.addWidget(
        "toggle",
        signal.label,
        !!this._signals[signal.label],
        () => this._poll(),
        { on: "true", off: "false" },
      );
      w._signalLabel = signal.label;
    }

    this._syncInputs();
    this.setDirtyCanvas(true, true);
  }

  /** One BOOLEAN input per signal, reconciled by name so links survive reload. */
  _syncInputs() {
    const wanted = this.properties.signals.map((s) => s.label);
    for (let i = (this.inputs?.length || 0) - 1; i >= 0; i--) {
      if (!wanted.includes(this.inputs[i].name)) this.removeInput(i);
    }
    for (const label of wanted) {
      if (this.findInputSlot(label) === -1) this.addInput(label, "BOOLEAN");
    }
  }

  /** Find every Controller this node feeds, by walking its `patch` output
   *  outward and crossing subgraph-output boundaries (child->parent, the reliable
   *  direction). Same-graph receivers are found directly. */
  _collectBusTargets() {
    const acc = new Set();
    this._walkBusOutput(this._graph(), this, 0, 0, acc, new Set());
    return [...acc];
  }

  _walkBusOutput(graph, node, slot, depth, acc, visited) {
    if (!graph || !node || depth > 10) return;
    const key = `${graph.id != null ? graph.id : "root"}:${node.id}:${slot}`;
    if (visited.has(key)) return;
    visited.add(key);

    // a) Direct links out of this slot, in this graph.
    for (const linkId of outgoingLinkIds(graph, node, slot)) {
      const link = linkById(graph, linkId);
      if (!link) continue;
      const target = nodeById(graph, link.target_id);
      if (!target) continue;
      if (isReceivingController(target)) {
        acc.add(target);
        continue;
      }
      // Hit the subgraph's output proxy -> hop to the host's output in the parent.
      const up = crossOutputToParent(graph, target, link.target_slot);
      if (up) {
        this._walkBusOutput(up.graph, up.node, up.slot, depth + 1, acc, visited);
        continue;
      }
      // Landed on a subgraph instance's input -> descend and keep walking inside,
      // so a controller living in a sibling/nested subgraph is still reached.
      const into = crossInputToChild(target, link.target_slot);
      if (into) this._walkBusOutput(into.graph, into.node, into.slot, depth + 1, acc, visited);
    }

    // b) Boundary crossing by reverse lookup: whichever of this graph's outputs
    //    this slot feeds, continue from the host's matching output in the parent.
    //    (Covers connections to the subgraph output not captured by the link scan.)
    for (const k of subgraphOutputsFedBy(graph, node, slot)) {
      const { host, parentGraph } = findSubgraphHost(graph);
      if (host && parentGraph) this._walkBusOutput(parentGraph, host, k, depth + 1, acc, visited);
    }
  }

  /** Mirror the signal list to the set of labels the bound Controllers demand:
   *  add a signal per new label, drop one no longer demanded UNLESS a boolean is
   *  still wired into it (don't strand the user's wiring). Returns true on change. */
  _reconcileAutoSignals(demanded) {
    let changed = false;
    for (const label of demanded) {
      if (!this.properties.signals.some((s) => s.label === label)) {
        this.properties.signals.push({ label });
        changed = true;
      }
    }
    for (let i = this.properties.signals.length - 1; i >= 0; i--) {
      const signal = this.properties.signals[i];
      if (demanded.has(signal.label)) continue;
      const slot = this.findInputSlot(signal.label);
      const wired = slot !== -1 && this.inputs?.[slot]?.link != null;
      if (wired) continue; // keep: a boolean is wired in, don't strand it
      this.properties.signals.splice(i, 1);
      changed = true;
    }
    return changed;
  }

  /** Stable per-session key identifying this Wired Controller as a signal source. */
  _busKey() {
    if (!this.__busKey) this.__busKey = `${this.id}:${Math.floor(Math.random() * 1e9)}`;
    return this.__busKey;
  }

  /** Drive everything: discover the Controllers we feed, mirror their targets as
   *  inputs, resolve our booleans locally, then deliver the result. */
  _poll() {
    const graph = this._graph();

    // 1) Find the Controllers we feed and pull their target labels as demand.
    const targets = this._collectBusTargets();
    const demanded = new Set();
    for (const target of targets) {
      for (const control of target.properties.controls || []) demanded.add(control.label);
    }
    for (const label of SwitchboardBus.demandedLabels(this.properties.channel, Date.now())) {
      demanded.add(label);
    }

    // 2) Mirror the input list to that demand (auto add/prune).
    if (this._reconcileAutoSignals(demanded)) {
      this._buildWidgets();
      this.size[1] = Math.max(this.size[1], this.computeSize()[1]);
    }

    // 3) Resolve every wired boolean locally -- always reliable, it's our graph.
    const signals = {};
    for (const signal of this.properties.signals) {
      const slot = this.findInputSlot(signal.label);
      if (slot === -1) continue;
      const input = this.inputs?.[slot];
      if (!input || input.link == null) continue; // unwired -> omit, leave target manual
      const value = resolveBoolean(graph, input.link, 0);
      if (value !== null) signals[signal.label] = value;
    }
    this._signals = signals;
    if (this.outputs?.[0]) this.outputs[0]._data = signals;

    // 4) Deliver: push straight onto each bound Controller (wire) + publish (channel).
    for (const target of targets) {
      if (typeof target._receivePushedSignals === "function") {
        target._receivePushedSignals(this._busKey(), signals);
      }
    }
    SwitchboardBus.publish(this.properties.channel, signals);

    // Mirror onto the readout toggles for visual feedback.
    let dirty = false;
    for (const w of this.widgets || []) {
      if (!w._signalLabel) continue;
      const v = !!signals[w._signalLabel];
      if (w.value !== v) {
        w.value = v;
        dirty = true;
      }
    }
    if (dirty) this.setDirtyCanvas(true, true);
  }

  getExtraMenuOptions(_, options) {
    options.push({
      content: "Log Wired Controller diagnostics (console)",
      callback: () => this._logDiagnostics(),
    });
  }

  /** Dump the output-walk so a failing wire binding can be diagnosed. Open the
   *  browser console (F12), right-click the node, run this, and copy the object. */
  _logDiagnostics() {
    const graph = this._graph();
    const out0 = this.outputs?.[0] || {};
    const host = findSubgraphHost(graph);
    const targets = this._collectBusTargets();
    const describe = (n) =>
      n ? { id: n.id, type: n.type, ctor: n.constructor?.name, title: n.title } : null;
    const info = {
      node: WiredControllerNode.nodeTitle,
      channel: this.properties.channel || "",
      inRootGraph: graph === app.graph,
      graphCtor: graph?.constructor?.name || null,
      graphId: graph?.id ?? null,
      output: {
        type: out0.type,
        rawLinks: out0.links || null,
        floatingLinks: out0._floatingLinks ? out0._floatingLinks.length : 0,
      },
      outgoingLinkIds: outgoingLinkIds(graph, this, 0),
      subgraphOutputsFedBy: subgraphOutputsFedBy(graph, this, 0),
      hasOutputProxy: !!(graph?.outputNode || graph?._outputNode || graph?.output_node),
      foundHost: describe(host.host),
      hostParentGraphCtor: host.parentGraph?.constructor?.name || null,
      hostOutputs: host.host ? (host.host.outputs || []).map((o) => ({ name: o.name, links: o.links || null })) : null,
      hostOutputResolved:
        host.host && host.parentGraph
          ? (host.host.outputs || []).map((o, slot) => ({
              slot,
              name: o.name,
              targets: outgoingLinkIds(host.parentGraph, host.host, slot).map((id) => {
                const l = linkById(host.parentGraph, id);
                const t = l ? nodeById(host.parentGraph, l.target_id) : null;
                return t
                  ? {
                      ...describe(t),
                      slot: l.target_slot,
                      isController: isReceivingController(t),
                      isSubgraphInstance: !!subgraphOf(t),
                    }
                  : { unresolvedLink: id };
              }),
            }))
          : null,
      collectedTargets: targets.map(describe),
      signals: this._signals,
    };
    console.log("[Switchboard] WIRED DIAGNOSTICS - copy this:", info);
    return info;
  }

  onAdded() {
    this._poll();
    if (!this._pollTimer) this._pollTimer = setInterval(() => this._poll(), 200);
  }

  onRemoved() {
    if (this._pollTimer) {
      clearInterval(this._pollTimer);
      this._pollTimer = null;
    }
  }

  onConfigure() {
    if (!Array.isArray(this.properties.signals)) this.properties.signals = [];
    this._ensurePatchOutput(); // rename the output on older saved nodes
    this._buildWidgets();
    setTimeout(() => this._poll(), 0);
  }

  // Re-poll on any wiring change: an INPUT change is a new boolean to read; an
  // OUTPUT change is a Controller wired in/out, so discovery must re-run.
  onConnectionsChange() {
    this._poll();
  }
}
WiredControllerNode.nodeTitle = "Wired Controller";

// ---- Set / Get (any-type tunnel) -------------------------------------------
//
// Not a Controller -- a plain wiring convenience, in the spirit of the
// Set/Get pairs several other packs ship (e.g. ComfyUI-Easy-Use's
// "easy setNode"/"easy getNode"). Lets a value of ANY type (image, latent,
// model, conditioning, ...) reach a distant part of the graph by NAME instead
// of a long wire, which is the readability problem in a big, branchy graph
// that tags/groups don't solve -- those gate *execution*, this threads *data*.
//
// Both are virtual: Get resolves to the real upstream link at serialize time
// via `getInputLink`, litegraph's own mechanism for a virtual node to stand in
// for a real one (confirmed against the shipped frontend: the executor calls
// `node.getInputLink(slot)` and recurses through `.resolve()` on whatever it
// gets back). Handing back the Setter's own (unmodified, already-real) input
// link -- rather than building a new link object -- is what makes this work
// without depending on a specific Link class shape, and it's why a Get can sit
// downstream of another Get/Set with no special-case chaining code: each hop
// resolves through the exact same call.

/** Every name currently claimed by a Switchboard Set node in `graph`. */
function getSwitchboardSetterNames(graph) {
  const names = new Set();
  for (const node of getGraphNodes(graph)) {
    if (node.constructor && node.constructor.isSwitchboardSetNode) {
      const name = node.widgets?.[0]?.value;
      if (name) names.add(name);
    }
  }
  return [...names].sort();
}

/** Every Get node in `graph` bound to `name`, so a rename/removal on the
 *  Setter side can refresh them immediately instead of waiting on their own
 *  next poll/interaction. */
function getSwitchboardGettersFor(graph, name) {
  const getters = [];
  for (const node of getGraphNodes(graph)) {
    if (node.constructor && node.constructor.isSwitchboardGetNode && node.widgets?.[0]?.value === name) {
      getters.push(node);
    }
  }
  return getters;
}

class SwitchboardSetNode extends LGraphNode {
  static nodeTitle = "Set";
  static isSwitchboardSetNode = true;

  constructor(title = SwitchboardSetNode.nodeTitle) {
    super(title);
    this.isVirtualNode = true; // never sent to the server; purely a wiring aid
    this.serialize_widgets = true;
    this.addInput("*", "*");
    this._lastName = ""; // tracked ourselves: widget callbacks get the new value only
    this.addWidget("text", "name", "", (value) => this._onRename(value), {});
    this.size = [160, 60];
  }

  _graph() {
    return this.graph || app.graph;
  }

  _retitle() {
    const name = this.widgets[0].value;
    this.title = name ? `Set: ${name}` : SwitchboardSetNode.nodeTitle;
  }

  /** Keep names unique -- two Setters sharing a name would make a Getter's
   *  match ambiguous (silently picking whichever is found first), which is
   *  exactly the kind of "works sometimes, not others" bug this is meant to
   *  avoid, not introduce. Appends `_2`, `_3`, ... until it's free. */
  _dedupeName(name) {
    if (!name) return name;
    const taken = new Set(
      getGraphNodes(this._graph())
        .filter((n) => n !== this && n.constructor && n.constructor.isSwitchboardSetNode)
        .map((n) => n.widgets?.[0]?.value)
        .filter(Boolean),
    );
    if (!taken.has(name)) return name;
    let i = 2;
    while (taken.has(`${name}_${i}`)) i++;
    return `${name}_${i}`;
  }

  _onRename(value) {
    const prevValue = this._lastName;
    const deduped = this._dedupeName((value || "").trim());
    this.widgets[0].value = deduped;
    this._lastName = deduped;
    this._retitle();
    // Getters bound to the OLD name lose their Setter; refresh them so they
    // show it immediately instead of silently pointing at nothing until their
    // own combo is reopened.
    for (const getter of getSwitchboardGettersFor(this._graph(), prevValue)) getter._refresh();
    for (const getter of getSwitchboardGettersFor(this._graph(), deduped)) getter._refresh();
  }

  _refreshType() {
    const link = this.inputs[0].link != null ? linkById(this._graph(), this.inputs[0].link) : null;
    this.inputs[0].type = link ? link.type : "*";
  }

  onConnectionsChange(type) {
    if (type !== LiteGraph.INPUT) return;
    this._refreshType();
    for (const getter of getSwitchboardGettersFor(this._graph(), this.widgets[0].value)) getter._refresh();
  }

  onConfigure() {
    // A loaded workflow restores widgets_values directly, bypassing the
    // callback above -- resync our own tracked copy so a later rename still
    // finds the right "previous" name to refresh.
    this._lastName = this.widgets[0].value;
    this._retitle();
  }

  onRemoved() {
    for (const getter of getSwitchboardGettersFor(this._graph(), this.widgets?.[0]?.value)) getter._refresh();
  }
}

class SwitchboardGetNode extends LGraphNode {
  static nodeTitle = "Get";
  static isSwitchboardGetNode = true;

  constructor(title = SwitchboardGetNode.nodeTitle) {
    super(title);
    this.isVirtualNode = true;
    this.serialize_widgets = true;
    this.addOutput("*", "*");
    this.addWidget("combo", "name", "", () => this._refresh(), {
      values: () => getSwitchboardSetterNames(this._graph()),
    });
    this.size = [160, 60];
  }

  _graph() {
    return this.graph || app.graph;
  }

  _findSetter() {
    const name = this.widgets[0].value;
    if (!name) return null;
    return getGraphNodes(this._graph()).find(
      (n) => n.constructor && n.constructor.isSwitchboardSetNode && n.widgets?.[0]?.value === name,
    );
  }

  _refresh() {
    const setter = this._findSetter();
    const name = this.widgets[0].value;
    const type = setter ? setter.inputs[0].type : "*";
    this.outputs[0].type = type;
    this.outputs[0].name = type;
    this.title = name ? `Get: ${name}${setter ? "" : " (missing)"}` : SwitchboardGetNode.nodeTitle;
    this.setDirtyCanvas(true, true);
  }

  /** litegraph's hook for a virtual node to hand back the REAL link feeding
   *  it, used when flattening the graph to a prompt. Returning the Setter's
   *  own (unmodified) input link -- rather than fabricating a new one --
   *  means this chains correctly even when that link's origin is itself
   *  another virtual node (Set/Get or anything else): whatever resolves it
   *  next just keeps following the same real link object. */
  getInputLink(_slot) {
    const setter = this._findSetter();
    const linkId = setter?.inputs[0]?.link;
    if (linkId == null) {
      throw new Error(`Switchboard Get "${this.widgets[0].value}": no Set node is feeding a value in.`);
    }
    return linkById(this._graph(), linkId);
  }

  onConfigure() {
    this._refresh();
  }

  onAdded() {
    this._refresh();
  }
}

app.registerExtension({
  name: "Switchboard.Controllers",
  registerCustomNodes() {
    for (const Cls of [GroupControllerNode, NodeControllerNode, TagControllerNode, WiredControllerNode]) {
      Cls.title = Cls.nodeTitle;
      Cls.collapsable = true;
      LiteGraph.registerNodeType(Cls.nodeTitle, Cls);
      Cls.category = CATEGORY;
    }
  },
});

app.registerExtension({
  name: "Switchboard.SetGet",
  registerCustomNodes() {
    for (const Cls of [SwitchboardSetNode, SwitchboardGetNode]) {
      Cls.title = Cls.nodeTitle;
      Cls.collapsable = true;
      LiteGraph.registerNodeType(`Switchboard ${Cls.nodeTitle}`, Cls);
      Cls.category = CATEGORY;
    }
  },
});

// ---- tag assignment (any node) ---------------------------------------------
//
// The context-menu side of tagging: added to every node (our own Controllers
// excepted -- they can't be tag targets, same as Group/Node Controller). Right
// click picks up the current canvas multi-selection, so tagging several nodes
// at once -- the whole point in a big, non-contiguous graph -- is one prompt,
// not one per node.

/** The nodes a tag edit on `node` should affect: the full multi-selection when
 *  `node` is part of it (so right-clicking any one of several selected nodes
 *  tags all of them), otherwise just `node` alone. */
function tagEditTargets(node) {
  const selected = app.canvas && app.canvas.selected_nodes;
  if (selected && selected[node.id] != null) {
    const nodes = Object.values(selected).filter(
      (n) => !(n && n.constructor && n.constructor.isSwitchboardController),
    );
    if (nodes.length > 1) return nodes;
  }
  return [node];
}

function addTagsToNode(node, raw) {
  const additions = String(raw || "")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
  if (!additions.length) return;
  setNodeTags(node, [...nodeTags(node), ...additions]);
}

function removeTagFromNode(node, tag) {
  setNodeTags(
    node,
    nodeTags(node).filter((t) => t !== tag),
  );
}

/** Whether `node` should get the Tag/Remove-tag menu entries at all -- our own
 *  Controllers can't be tag targets, same rule as Group/Node Controller. */
function nodeWantsTagMenu(node) {
  return !!node && !(node.constructor && node.constructor.isSwitchboardController);
}

/** The Tag… / Remove tag menu entries for `node`, shared by both places that
 *  add them (see the two `registerExtension` blocks below). Each entry carries
 *  `_switchboardTagEntry` so either path can tell "already added" from "not
 *  added yet" and skip re-adding -- belt-and-suspenders against a double menu
 *  item if BOTH paths manage to fire for the same node. */
function buildTagMenuEntries(node) {
  const targets = tagEditTargets(node);
  const entries = [
    {
      content: targets.length > 1 ? `🎛️ Tag ${targets.length} selected nodes…` : "🎛️ Tag…",
      _switchboardTagEntry: true,
      callback: () => {
        // eslint-disable-next-line no-alert -- quick text input is the
        // established LiteGraph/ComfyUI idiom for this (rename, add label).
        const value = prompt("Switchboard tag(s), comma-separated:", nodeTags(node).join(", "));
        if (value == null) return; // cancelled
        for (const n of targets) addTagsToNode(n, value);
      },
    },
  ];
  const tags = nodeTags(node);
  if (tags.length) {
    entries.push({
      content: "🎛️ Remove tag",
      _switchboardTagEntry: true,
      has_submenu: true,
      submenu: {
        options: tags.map((tag) => ({
          content: tag,
          callback: () => {
            for (const n of targets) removeTagFromNode(n, tag);
          },
        })),
      },
    });
  }
  return entries;
}

app.registerExtension({
  name: "Switchboard.Tags",
  nodeCreated(node) {
    // Primary path: wraps this node instance's own getExtraMenuOptions, which
    // ComfyUI's canvas always calls while building the node's context menu
    // (verified against the shipped litegraph bundle: `getNodeMenuOptions`
    // calls `node.getExtraMenuOptions?.(canvas, options)` and keeps whatever
    // that call pushed into `options`, regardless of its return value -- the
    // same push-don't-return contract the Controllers' own
    // getExtraMenuOptions above relies on).
    if (!nodeWantsTagMenu(node)) return;
    const orig = node.getExtraMenuOptions;
    node.getExtraMenuOptions = function (canvas, options) {
      orig?.apply(this, arguments);
      if (!options.some((o) => o && o._switchboardTagEntry)) {
        options.push(...buildTagMenuEntries(this));
      }
    };
  },
});

// Defence in depth, patched ONCE at module load (not once per node, unlike
// the primary path above). Several installed custom-node packs also wrap
// getExtraMenuOptions per node instance, and not all of them chain the
// previous implementation before replacing it -- a pack that doesn't would
// silently drop our addition for whichever node types it touches. Patching
// the canvas-level getNodeMenuOptions as a second, independent path means the
// Tag item still shows up when that happens, at the cost of a single,
// much-rarer collision point instead of one per node type.
if (typeof LGraphCanvas !== "undefined" && !LGraphCanvas.prototype.__switchboardPatchedNodeMenu) {
  const origGetNodeMenuOptions = LGraphCanvas.prototype.getNodeMenuOptions;
  LGraphCanvas.prototype.getNodeMenuOptions = function (node) {
    const options = origGetNodeMenuOptions.apply(this, arguments);
    if (Array.isArray(options) && nodeWantsTagMenu(node) && !options.some((o) => o && o._switchboardTagEntry)) {
      options.push(...buildTagMenuEntries(node));
    }
    return options;
  };
  LGraphCanvas.prototype.__switchboardPatchedNodeMenu = true;
}
