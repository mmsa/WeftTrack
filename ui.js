"use strict";

const $ = selector => document.querySelector(selector);
const svgNS = "http://www.w3.org/2000/svg";
const paths = {
  board: "M3 4h18v16H3z M9 4v16m6-16v16",
  graph: "M5 5v11a3 3 0 0 0 3 3h7 M5 8h8a3 3 0 0 0 3-3 M3 3h4v4H3z M15 2h4v4h-4z M15 17h4v4h-4z",
  code: "m8 6-6 6 6 6m8-12 6 6-6 6m-3-15-3 18",
  layers: "m12 3 9 5-9 5-9-5z M3 12l9 5 9-5 M3 16l9 5 9-5",
  chevrons: "m8 9 4-4 4 4m-8 6 4 4 4-4",
  database: "M4 6c0-5 16-5 16 0s-16 5-16 0zm0 0v12c0 5 16 5 16 0V6 M4 12c0 5 16 5 16 0",
  open: "M4 12a8 8 0 1 0 16 0 8 8 0 1 0-16 0z",
  active: "M4 12a8 8 0 1 0 16 0 8 8 0 1 0-16 0z M12 4v16a8 8 0 0 0 0-16z",
  review: "m12 3 9 9-9 9-9-9z M9 12h6",
  done: "M4 12a8 8 0 1 0 16 0 8 8 0 1 0-16 0z M8.5 12l2.3 2.3 4.7-5",
  plus: "M12 5v14m-7-7h14", close: "m6 6 12 12M18 6 6 18",
  search: "M3 10a7 7 0 1 0 14 0 7 7 0 1 0-14 0zm12 5 6 6",
  filter: "M3 7h18M6 12h12m-9 5h6",
  arrow: "M4 12h15m-6-6 6 6-6 6", expand: "M6 18 18 6M7 6h11v11",
  link: "m9 14 6-6m-3-2 2-2a4 4 0 0 1 6 6l-4 4m-4 4-2 2a4 4 0 0 1-6-6l4-4",
  blocks: "M4 12a8 8 0 1 0 16 0 8 8 0 1 0-16 0zm3-5 10 10",
  branch: "M6 4v14m0-8h8a4 4 0 0 0 4-4 M4 17h4v4H4z M16 2h4v4h-4z",
};
const lanes = { open: "Open", active: "In progress", review: "In review", done: "Done" };
const edgeLabels = {
  blocks: ["blocks", "blocked by"],
  parent_of: ["parent of", "child of"],
  implements: ["implements", "implemented by"],
};
const views = { board: "Delivery board", graph: "Relationship map", changes: "Code changes" };
const workspaces = { local: "My workspace", example: "Example project" };
const state = { workspace: "local", view: "board", query: "", filter: "all", focus: null };
let graph = { nodes: [], edges: [], transitions: {} };
let nodes = new Map();
let adjacent = new Map();
let loading = 0;
let noticeTimer;
let mapObserver;

function el(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== null && text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function svg(tag, attributes) {
  const node = document.createElementNS(svgNS, tag);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value);
  return node;
}

function icon(name) {
  const image = svg("svg", { viewBox: "0 0 24 24", class: "icon", "aria-hidden": "true", fill: "none", stroke: "currentColor", "stroke-width": 1.7, "stroke-linecap": "round", "stroke-linejoin": "round" });
  image.append(svg("path", { d: paths[name] }));
  return image;
}

function button(label, className, action, symbol) {
  const node = el("button", null, className);
  node.type = "button";
  if (symbol) node.append(icon(symbol));
  node.append(document.createTextNode(label));
  node.addEventListener("click", action);
  return node;
}

function drawWeave() {
  const strands = [
    ["#31715b", -54, 57], ["#75a381", -8, 25], ["#a19d60", 81, -22],
  ];
  for (const [color, start, offset] of strands) {
    for (let i = 0; i < 7; i++) {
      const y = start + i * 5;
      $("#threads").append(svg("path", {
        d: `M-35 ${y} H28 C100 ${y} 120 ${y + 91} 187 ${y + 91} S263 ${y + offset} 332 ${y + offset} H475`,
        stroke: color,
      }));
    }
  }
}

function message(text, error = false) {
  clearTimeout(noticeTimer);
  $("#notice").textContent = text;
  $("#notice").toggleAttribute("data-error", error);
  if (!error) noticeTimer = setTimeout(() => { $("#notice").textContent = ""; }, 4200);
}

async function request(workspace, path, method = "GET", body) {
  const response = await fetch((workspace === "example" ? "/example" : "") + path, {
    method, headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Request failed");
  return data;
}

function key(node) {
  return (node.kind === "change" ? "CH-" : "WT-") + String(node.number ?? node.id.slice(0, 6)).padStart(3, "0");
}

function relationList(node) {
  return adjacent.get(node.id) || [];
}

function getView() {
  const hash = location.hash.slice(1);
  return Object.hasOwn(views, hash) ? hash : "board";
}

function connection(text, offline = false) {
  $("#connection").textContent = text;
  $(".connection").classList.toggle("offline", offline);
}

async function load(workspace, firstLaunch = false) {
  const loadId = ++loading;
  connection("Connecting");
  try {
    let data = await request(workspace, "/graph");
    if (firstLaunch && !data.nodes.length && workspace === "local") {
      workspace = "example";
      data = await request(workspace, "/graph");
    }
    if (loadId !== loading) return;
    const switched = workspace !== state.workspace;
    state.workspace = workspace;
    if (switched) Object.assign(state, { focus: null, query: "", filter: "all" });
    graph = data;
    nodes = new Map(graph.nodes.map(node => [node.id, node]));
    adjacent = new Map(graph.nodes.map(node => [node.id, []]));
    for (const edge of graph.edges) {
      adjacent.get(edge.source)?.push(edge);
      adjacent.get(edge.target)?.push(edge);
    }
    $("#workspace").value = workspace;
    connection("Local server");
    render();
  } catch (error) {
    if (loadId !== loading) return;
    $("#workspace").value = state.workspace;
    connection("Connection failed", true);
    throw error;
  }
}

function badge(text, cls, symbol) {
  const tag = el("span", null, "tag " + cls);
  tag.append(icon(symbol), document.createTextNode(text));
  return tag;
}

function isBlocked(node) {
  return relationList(node).some(edge => edge.kind === "blocks" && edge.target === node.id && nodes.get(edge.source)?.status !== "done");
}

function card(node) {
  const item = button("", "card", () => showDetails(node.id));
  const top = el("span", null, "card-top");
  top.append(el("span", key(node), "key"), icon("expand"));
  item.append(top, el("span", node.title, "card-title"));
  const meta = el("span", null, "card-meta");
  const edges = relationList(node);
  const children = edges.filter(e => e.kind === "parent_of" && e.source === node.id).length;
  if (isBlocked(node)) meta.append(badge("Blocked", "blocked", "blocks"));
  if (edges.some(e => e.kind === "blocks" && e.source === node.id) && node.status !== "done") meta.append(badge("Blocker", "blocks", "link"));
  if (children) meta.append(badge(children + (children === 1 ? " child" : " children"), "parent", "branch"));
  if (edges.some(e => e.kind === "implements")) meta.append(badge("Code linked", "code", "code"));
  if (!meta.childElementCount && edges.length) meta.append(badge(edges.length + (edges.length === 1 ? " link" : " links"), "child", "link"));
  if (meta.childElementCount) item.append(meta);
  return item;
}

function toolbar(title, total, controls) {
  const bar = el("div", null, "toolbar");
  const heading = el("div", null, "panel-title");
  const count = el("span", total, "count");
  count.id = "view-count";
  heading.append(el("h2", title), count);
  const actions = el("div", null, "actions");
  actions.append(...controls);
  bar.append(heading, actions);
  return bar;
}

function searchControl() {
  const wrap = el("label", null, "searchbox");
  const input = el("input");
  input.type = "search";
  input.placeholder = "Search work…";
  input.setAttribute("aria-label", "Search work by title or key");
  input.value = state.query;
  input.addEventListener("input", () => { state.query = input.value; drawLanes(); });
  wrap.append(icon("search"), input);
  return wrap;
}

function selector(entries, label) {
  const select = el("select");
  select.setAttribute("aria-label", label);
  for (const [value, text] of entries) select.add(new Option(text, value));
  return select;
}

function filterControl() {
  const wrap = el("label", null, "filterbox");
  const select = selector([["all", "All work"], ["blocked", "Blocked"], ["linked", "Linked"], ["unlinked", "Unlinked"]], "Filter work");
  select.value = state.filter;
  select.onchange = () => { state.filter = select.value; drawLanes(); };
  wrap.append(icon("filter"), select);
  return wrap;
}

function entityButton(node) {
  const control = button("", "entity-link", () => showDetails(node.id));
  control.append(el("span", key(node), "key"), el("span", node.title));
  return control;
}

function relationshipRows(edges, emptyText) {
  const panel = el("div", null, "panel");
  if (!edges.length) panel.append(el("p", emptyText, "empty"));
  for (const edge of edges) {
    const row = el("div", null, "relation-row");
    const type = el("span", null, "edge-name");
    type.append(icon("arrow"), document.createTextNode(edgeLabels[edge.kind][0]));
    row.append(entityButton(nodes.get(edge.source)), type, entityButton(nodes.get(edge.target)));
    panel.append(row);
  }
  return panel;
}

function drawLanes() {
  const board = $(".board");
  const query = state.query.trim().toLowerCase();
  const work = graph.nodes.filter(node => node.kind === "work" &&
    (key(node) + " " + node.title).toLowerCase().includes(query) &&
    (state.filter === "all" || (state.filter === "blocked" && isBlocked(node)) ||
     (state.filter === "linked" && relationList(node).length) ||
     (state.filter === "unlinked" && !relationList(node).length)));
  $("#view-count").textContent = work.length;
  board.replaceChildren();
  for (const [status, title] of Object.entries(lanes)) {
    const items = work.filter(node => node.status === status);
    const lane = el("section", null, "lane");
    lane.dataset.status = status;
    const heading = el("div", null, "lane-title");
    heading.append(icon(status), el("h3", title), el("span", items.length, "count"));
    const stack = el("div", null, "cards");
    stack.append(...items.map(card));
    if (!items.length) stack.append(el("p", query || state.filter !== "all" ? "No matching items" : "No work items", "lane-empty"));
    lane.append(heading, stack);
    board.append(lane);
  }
}

function sectionHeading(title, extra) {
  const head = el("div", null, "section-head");
  head.append(el("h2", title));
  if (extra) head.append(extra);
  return head;
}

function renderBoard(content) {
  const board = el("div", null, "board");
  content.append(toolbar("Work items", 0, [searchControl(), filterControl(), button("New item", "btn primary", () => openForm("work"), "plus")]), board);
  drawLanes();
  const blockers = graph.edges.filter(edge => edge.kind === "blocks" && nodes.get(edge.source).status !== "done" && nodes.get(edge.target).status !== "done");
  const section = el("section", null, "board-foot");
  const openMap = button("View map", "text-btn", () => {
    if (blockers.length) state.focus = blockers[0].source;
    location.hash = "graph";
  }, "graph");
  section.append(sectionHeading("Active dependencies", openMap), relationshipRows(blockers, "No open work items are blocking delivery."));
  content.append(section);
}

function mapNode(node, caption, focus) {
  const target = button("", focus ? "map-node focus" : "map-node", () => {
    if (focus) showDetails(node.id);
    else { state.focus = node.id; render(); $("#map-focus")?.focus(); }
  });
  target.append(el("span", key(node), "key"), el("b", node.title), el("small", caption));
  return target;
}

function mapColumn(title, items, emptyText) {
  const column = el("div", null, "graph-column");
  const stack = el("div", null, "graph-nodes");
  stack.append(...items);
  if (!items.length) stack.append(el("p", emptyText, "map-null"));
  column.append(el("p", title, "graph-label"), stack);
  return column;
}

function connectMap(stage, wires) {
  const draw = () => {
    const focus = stage.querySelector(".focus");
    if (!focus || !stage.isConnected) return;
    const area = stage.getBoundingClientRect();
    const center = focus.getBoundingClientRect();
    wires.replaceChildren();
    const defs = svg("defs", {});
    const marker = svg("marker", { id: "arrowhead", viewBox: "0 0 8 8", refX: "7", refY: "4", markerWidth: "6", markerHeight: "6", orient: "auto" });
    marker.append(svg("path", { d: "M0 0L8 4L0 8Z", fill: "#6a896f" }));
    defs.append(marker);
    wires.append(defs);
    for (const item of stage.querySelectorAll(".map-node:not(.focus)")) {
      const rect = item.getBoundingClientRect();
      const incoming = item.closest(".graph-column") === stage.querySelector(".graph-column");
      const from = incoming ? rect : center;
      const to = incoming ? center : rect;
      const vertical = getComputedStyle(stage).gridTemplateColumns.split(" ").length === 1;
      let path;
      if (vertical) {
        const x1 = from.left + from.width / 2 - area.left, x2 = to.left + to.width / 2 - area.left;
        const y1 = from.bottom - area.top, y2 = to.top - area.top - 1;
        const mid = (y1 + y2) / 2;
        path = `M${x1} ${y1} C${x1} ${mid} ${x2} ${mid} ${x2} ${y2}`;
      } else {
        const x1 = from.right - area.left, x2 = to.left - area.left - 1;
        const y1 = from.top + from.height / 2 - area.top, y2 = to.top + to.height / 2 - area.top;
        const mid = (x1 + x2) / 2;
        path = `M${x1} ${y1} C${mid} ${y1} ${mid} ${y2} ${x2} ${y2}`;
      }
      wires.append(svg("path", { d: path,
        stroke: "#78977a", "stroke-width": 1.5, fill: "none", "marker-end": "url(#arrowhead)" }));
    }
  };
  mapObserver = new ResizeObserver(draw);
  mapObserver.observe(stage);
  for (const item of stage.querySelectorAll(".map-node")) mapObserver.observe(item);
  requestAnimationFrame(draw);
}

function initialFocus() {
  // A node with neighbors on both sides makes the direction of links visible.
  function rank(node) {
    const links = relationList(node);
    const hasBoth = links.some(edge => edge.target === node.id) && links.some(edge => edge.source === node.id);
    return (hasBoth ? graph.edges.length : 0) + links.length;
  }
  return graph.nodes.reduce((best, node) => rank(node) > rank(best) ? node : best);
}

function renderMap(content) {
  content.append(toolbar("Relationship explorer", graph.edges.length, [button("New relationship", "btn primary", () => openForm("link"), "plus")]));
  if (graph.nodes.length) {
    const focus = nodes.get(state.focus) || initialFocus();
    state.focus = focus.id;
    const map = el("div", null, "map");
    const controls = el("div", null, "map-controls");
    const label = el("label", "Focus on");
    label.htmlFor = "map-focus";
    const select = selector(graph.nodes.map(n => [n.id, key(n) + " · " + n.title]), "Focus on node");
    select.id = "map-focus"; select.className = "select-control"; select.value = focus.id;
    select.onchange = () => { state.focus = select.value; render(); $("#map-focus").focus(); };
    controls.append(label, select);
    const scroll = el("div", null, "map-scroll");
    const stage = el("div", null, "map-stage");
    const wires = svg("svg", { class: "map-wires", "aria-hidden": "true" });
    const edges = relationList(focus);
    const incoming = edges.filter(e => e.target === focus.id).map(e => mapNode(nodes.get(e.source), edgeLabels[e.kind][0] + " focused item", false));
    const outgoing = edges.filter(e => e.source === focus.id).map(e => mapNode(nodes.get(e.target), edgeLabels[e.kind][1] + " focused item", false));
    stage.append(wires, mapColumn("Incoming", incoming, "No incoming links"),
      mapColumn("Focused item", [mapNode(focus, "Open details ↗", true)]), mapColumn("Outgoing", outgoing, "No outgoing links"));
    scroll.append(stage); map.append(controls, scroll); content.append(map);
    connectMap(stage, wires);
  }
  const section = el("section", null, "section-spacer");
  section.append(sectionHeading("All relationships"), relationshipRows(graph.edges, "Create a relationship between two work items or link a code change to the work it implements."));
  content.append(section);
}

function renderChanges(content) {
  const changes = graph.nodes.filter(n => n.kind === "change");
  content.append(toolbar("Change registry", changes.length, [button("Register change", "btn primary", () => openForm("change"), "plus")]));
  const panel = el("div", null, "registry");
  const head = el("div", null, "registry-row head");
  head.append(el("span", "Code change"), el("span", "Repository"), el("span", "External ID"));
  panel.append(head);
  if (!changes.length) panel.append(el("p", "Register a code change to connect it to a work item.", "empty"));
  for (const item of changes) {
    const row = el("div", null, "registry-row");
    row.append(entityButton(item), el("span", item.repository), el("span", item.external_id, "key"));
    panel.append(row);
  }
  content.append(panel);
}

function render() {
  mapObserver?.disconnect();
  state.view = getView();
  const name = views[state.view];
  document.title = name + " · WeftTrack";
  $("#page-title").textContent = $("#crumb-view").textContent = name;
  $("#crumb-space").textContent = workspaces[state.workspace];
  $("#project").textContent = state.workspace === "example" ? "Export release · Example project" : "My workspace";
  const summary = $("#summary");
  summary.replaceChildren();
  const work = graph.nodes.filter(node => node.kind === "work");
  for (const [count, title] of [[work.length, "work item"], [graph.edges.length, "relationship"], [graph.nodes.length - work.length, "code change"]]) {
    const item = el("span");
    item.append(el("b", count), document.createTextNode(title + (count === 1 ? "" : "s")));
    summary.append(item);
  }
  document.querySelectorAll("[data-view]").forEach(a => {
    if (a.dataset.view === state.view) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  });
  const content = $("#content");
  content.replaceChildren();
  ({ board: renderBoard, graph: renderMap, changes: renderChanges })[state.view](content);
}

function showDialog(title) {
  const dialog = $("#dialog");
  const heading = el("div", null, "dialog-heading");
  const name = el("h2", title);
  name.id = "dialog-title";
  const close = button("", "icon-btn", () => dialog.close(), "close");
  close.setAttribute("aria-label", "Close dialog");
  heading.append(name, close);
  const content = el("div", null, "dialog-content");
  $("#dialog-body").replaceChildren(heading, content);
  if (!dialog.open) dialog.showModal();
  return content;
}

async function save(control, path, method, body, success, errorBox) {
  const workspace = state.workspace;
  control.disabled = true;
  errorBox.textContent = "";
  try {
    await request(workspace, path, method, body);
    $("#dialog").close();
    try {
      await load(workspace);
      message(success);
    } catch {
      message(success + " Reload the page to refresh this view.", true);
    }
  } catch (error) {
    errorBox.textContent = error.message;
  } finally {
    control.disabled = false;
  }
}

function showDetails(id) {
  const node = nodes.get(id);
  const content = showDialog(node.kind === "change" ? "Code change" : "Work item");
  const meta = el("div", null, "entity-meta");
  meta.append(el("span", key(node), "key"));
  if (node.status) {
    const status = el("span", null, "status-pill status-" + node.status);
    status.append(icon(node.status), document.createTextNode(lanes[node.status]));
    meta.append(status);
  }
  content.append(meta, el("h3", node.title, "detail-title"));
  if (node.kind === "change") content.append(el("p", node.repository + " / " + node.external_id, "detail-info"));
  const relations = el("div", null, "detail-block");
  relations.append(el("h3", "Relationships"));
  const edges = relationList(node);
  if (!edges.length) relations.append(el("p", "No linked items yet.", "detail-info"));
  for (const edge of edges) {
    const outgoing = edge.source === id;
    const row = el("div", null, "detail-row");
    row.append(el("small", edgeLabels[edge.kind][outgoing ? 0 : 1]), entityButton(nodes.get(outgoing ? edge.target : edge.source)));
    relations.append(row);
  }
  content.append(relations);
  const linkActions = el("div", null, "actions");
  linkActions.append(button("Link item", "btn", () => openForm("link", node), "link"), button("Explore map", "btn", () => {
    $("#dialog").close(); state.focus = id;
    if (state.view === "graph") render(); else location.hash = "graph";
  }, "graph"));
  content.append(linkActions);
  if (node.kind !== "work") return;
  const errorBox = el("p", null, "dialog-error");
  errorBox.setAttribute("role", "alert");
  const actions = el("div", null, "form-actions");
  const labels = { open: "Return to open", active: node.status === "open" ? "Start work" : "Return to progress", review: "Send to review", done: "Mark done" };
  for (const target of graph.transitions[node.status] || []) {
    const forward = Object.keys(lanes).indexOf(target) > Object.keys(lanes).indexOf(node.status);
    const control = button(labels[target], "btn" + (forward ? " primary" : ""), () => {
      save(control, "/work/" + id, "PATCH", { status: target }, "Moved to " + lanes[target] + ".", errorBox);
    }, target);
    actions.append(control);
  }
  content.append(actions, errorBox);
}

function field(label, name, control) {
  const wrap = el("div", null, "field");
  const caption = el("label", label);
  control.id = "form-" + name;
  caption.htmlFor = control.id;
  control.name = name;
  control.required = true;
  wrap.append(caption, control);
  return wrap;
}

function textInput(placeholder) {
  const input = el("input");
  input.placeholder = placeholder;
  return input;
}

function linkFields(form, sourceNode) {
  const kind = selector(Object.entries(edgeLabels).map(([value, labels]) => [value, labels[0]]), "Relationship type");
  const source = el("select"), target = el("select");
  form.append(field("Relationship", "kind", kind), field("From", "source", source), field("To", "target", target));
  if (sourceNode?.kind === "change") kind.value = "implements";
  function populate(select, items, preferred) {
    select.replaceChildren(new Option("Choose an item", ""));
    for (const item of items) select.add(new Option(key(item) + " · " + item.title, item.id));
    if (items.some(item => item.id === preferred)) select.value = preferred;
  }
  function targets() {
    populate(target, graph.nodes.filter(n => n.kind === "work" && n.id !== source.value), target.value);
  }
  function sources(preferred) {
    populate(source, graph.nodes.filter(n => n.kind === (kind.value === "implements" ? "change" : "work")), preferred);
    targets();
  }
  sources(sourceNode?.id);
  kind.onchange = () => sources(source.value);
  source.onchange = targets;
}

function openForm(type, sourceNode) {
  const configs = {
    work: ["New work item", "Create item", "/work", "POST", "Work item created."],
    link: ["New relationship", "Create relationship", "/links", "POST", "Relationship created."],
    change: ["Register code change", "Save change", "/changes", "PUT", "Code change saved."],
  };
  const [title, action, path, method, success] = configs[type];
  const content = showDialog(title);
  const form = el("form", null, "detail-block");
  form.style.gap = "15px";
  if (type === "link") linkFields(form, sourceNode);
  else {
    form.append(field("Title", "title", textInput(type === "work" ? "What needs to be done?" : "Describe the code change")));
    if (type === "change") form.append(field("Repository ID", "repository", textInput("e.g. exports/api")), field("External change ID", "external_id", textInput("e.g. PR-48")));
  }
  const errorBox = el("p", null, "dialog-error");
  errorBox.setAttribute("role", "alert");
  const actions = el("div", null, "form-actions");
  const submit = el("button", action, "btn primary");
  submit.type = "submit";
  actions.append(button("Cancel", "btn", () => $("#dialog").close()), submit);
  form.append(errorBox, actions);
  form.onsubmit = event => {
    event.preventDefault();
    save(submit, path, method, Object.fromEntries(new FormData(form)), success, errorBox);
  };
  content.append(form);
  form.querySelector("input,select")?.focus();
}

for (const placeholder of document.querySelectorAll("[data-icon]")) placeholder.append(icon(placeholder.dataset.icon));
drawWeave();
$("#dialog").addEventListener("click", event => { if (event.target === $("#dialog")) $("#dialog").close(); });
$("#workspace").addEventListener("change", async event => {
  const selected = event.target.value;
  try {
    await load(selected);
    if (state.workspace === selected) {
      try { localStorage.setItem("wefttrack.workspace", selected); } catch { /* Storage may be disabled. */ }
    }
  } catch (error) { message(error.message, true); }
});
window.addEventListener("hashchange", () => { $("#dialog").close(); render(); });
let storedWorkspace;
try { storedWorkspace = localStorage.getItem("wefttrack.workspace"); } catch { /* Storage may be disabled. */ }
const saved = Object.hasOwn(workspaces, storedWorkspace);
load(saved ? storedWorkspace : "local", !saved).catch(error => message("Unable to load workspace. " + error.message, true));
