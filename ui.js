"use strict";

const $ = selector => document.querySelector(selector);
const svgNS = "http://www.w3.org/2000/svg";
const paths = {
  users: "M15 20v-2a5 5 0 0 0-10 0v2m14 0v-2a5 5 0 0 0-3-4.6M13 7a3.5 3.5 0 1 1-7 0 3.5 3.5 0 0 1 7 0zm3-3a3.5 3.5 0 0 1 0 6.7",
  board: "M3 4h18v16H3z M9 4v16m6-16v16",
  list: "M3 6h2m3 0h13M3 12h2m3 0h13M3 18h2m3 0h13",
  graph: "M5 5v11a3 3 0 0 0 3 3h7 M5 8h8a3 3 0 0 0 3-3 M3 3h4v4H3z M15 2h4v4h-4z M15 17h4v4h-4z",
  code: "m8 6-6 6 6 6m8-12 6 6-6 6m-3-15-3 18",
  effort: "M4 20h16M6 16v-4m6 4V8m6 8V4",
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
const workTypes = { task: "Task", bug: "Bug", epic: "Epic" };
const priorities = { low: "Low", normal: "Normal", high: "High", urgent: "Urgent" };
const effortBands = { small: [1, 3], medium: [3, 8], large: [8, 24], epic: [24, 80] };
const edgeLabels = {
  blocks: ["blocks", "blocked by"],
  parent_of: ["parent of", "child of"],
  implements: ["implements", "implemented by"],
};
const views = { board: "Delivery board", requirements: "Requirements log", graph: "Relationship map", effort: "Effort", changes: "Code changes", users: "Users", settings: "Projects & team" };
const workspaces = { local: "My workspace", example: "Example project" };
const roles = { owner: "Owner", admin: "Admin", editor: "Editor", viewer: "Viewer" };
let settings = { actor: null, configured: false, projects: [], members: [] };
const state = { workspace: "local", view: "board", layout: "board", query: "", filter: "all", focus: null };
let graph = { nodes: [], edges: [], transitions: {} };
let nodes = new Map();
let adjacent = new Map();
let claimsByItem = new Map();
const captureDrafts = new Map();
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

function workspacePrefix(workspace) {
  return workspace === "example" ? "/example" : workspace === "local" ? "" : "/projects/" + workspace;
}

async function request(workspace, path, method = "GET", body) {
  const response = await fetch(workspacePrefix(workspace) + path, {
    method, headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json();
  if (!response.ok) {
    const error = new Error(data.error || "Request failed");
    error.conflicts = data.conflicts;
    throw error;
  }
  return data;
}

async function loadSettings() {
  settings = await request("local", "/settings");
  for (const id of Object.keys(workspaces)) {
    if (id !== "local" && id !== "example") delete workspaces[id];
  }
  for (const project of settings.projects) {
    if (!project.archived) workspaces[project.id] = project.name;
  }
  const select = $("#workspace");
  select.replaceChildren(...Object.entries(workspaces).map(([id, name]) => new Option(name, id)));
  select.value = state.workspace;
}

function mayEdit() {
  return Boolean(settings.actor && settings.actor.role !== "viewer");
}

function key(node) {
  return (node.kind === "change" ? "CH-" : "WT-") + String(node.number ?? node.id.slice(0, 6)).padStart(3, "0");
}

function relationList(node) {
  return adjacent.get(node.id) || [];
}

function getView() {
  const hash = location.hash.slice(1);
  return Object.hasOwn(views, hash) ? hash : "requirements";
}

function connection(text, offline = false) {
  $("#connection").textContent = text;
  $(".connection").classList.toggle("offline", offline);
}

async function load(workspace, focusId = null) {
  const loadId = ++loading;
  connection("Connecting");
  try {
    const data = await request(workspace, "/graph");
    if (loadId !== loading) return;
    const switched = workspace !== state.workspace;
    state.workspace = workspace;
    if (switched) Object.assign(state, { focus: null, query: "", filter: "all" });
    graph = data;
    claimsByItem = new Map((data.claims || []).filter(claim => !claim.closed_at).map(claim => [claim.item, claim]));
    nodes = new Map(graph.nodes.map(node => [node.id, node]));
    const canonicalFocus = data.change_aliases?.[focusId] || focusId;
    if (nodes.has(canonicalFocus)) state.focus = canonicalFocus;
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
  if (symbol) tag.append(icon(symbol));
  tag.append(document.createTextNode(text));
  return tag;
}

function isBlocked(node) {
  return relationList(node).some(edge => edge.kind === "blocks" && edge.target === node.id && nodes.get(edge.source)?.status !== "done");
}

function needsAttention(node) {
  return node.status !== "done" && (isBlocked(node) || node.priority === "urgent" || node.priority === "high");
}

function suggestWork(title, description, type) {
  const text = title + " " + description;
  const broad = /\b(epic|rollout|replatform|end.to.end|multi.service)\b/i.test(text);
  const defect = /\b(fix|bug|crash(?:es)?|regression|broken|incorrect)\b/i.test(text);
  const involved = /\b(migrat\w*|integrat\w*|permissions|authentication|stream(?:ing)?|refactor|redesign)\b/i.test(text);
  const narrow = /\b(rename|typo|copyedit|reword|verify|document|proofread)\b/i.test(text);
  return {
    type: broad ? "epic" : defect ? "bug" : "task",
    band: broad || type === "epic" ? "epic" : involved ? "large" : narrow ? "small" : "medium",
  };
}

function itemEstimate(node) {
  return effortBands[node.effort_band] ||
    effortBands[suggestWork(node.title, node.description || "", node.work_type).band];
}

function formatEffort([low, high]) {
  return low === high ? low + " h" : low + "–" + high + " h";
}

function card(node) {
  const item = button("", "card", () => showDetails(node.id));
  item.draggable = mayEdit() && !liveClaim(node);
  item.dataset.workId = node.id;
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
  if (node.work_type && node.work_type !== "task") meta.append(badge(workTypes[node.work_type], "child"));
  if (node.priority === "high" || node.priority === "urgent") meta.append(badge(priorities[node.priority], "blocked"));
  meta.append(badge(node.assignee || "Unassigned", "child"));
  item.append(meta);
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
  input.setAttribute("aria-label", "Search work by title, key, description, or assignee");
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
  const select = selector([["all", "All work"], ["attention", "Needs attention"], ["blocked", "Blocked"], ["unassigned", "Unassigned"], ["linked", "Linked"], ["unlinked", "Unlinked"]], "Filter work");
  if (settings.actor?.name) select.add(new Option("Assigned to me", "mine"), 1);
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

async function moveWork(workspace, id, status) {
  await request(workspace, "/work/" + id, "PATCH", { status });
  if (workspace !== state.workspace) return;
  const success = "Moved to " + lanes[status] + ".";
  try {
    await load(workspace);
    message(success);
  } catch {
    message(success + " Reload the page to refresh this view.", true);
  }
}

function listStatus(node) {
  const targets = graph.transitions[node.status] || [];
  const stage = el("span", null, "row-stage");
  stage.append(icon(node.status));
  if (!mayEdit() || !targets.length || liveClaim(node)) {
    stage.append(document.createTextNode(lanes[node.status]));
    return stage;
  }
  const select = selector([node.status, ...targets].map(status => [status, lanes[status]]), "Status for " + key(node));
  const workspace = state.workspace;
  select.id = "stage-" + node.id;
  select.onchange = async () => {
    const target = select.value;
    if (select.disabled || !targets.includes(target)) return;
    select.disabled = true;
    try {
      await moveWork(workspace, node.id, target);
      if (workspace === state.workspace && document.activeElement === document.body)
        (document.getElementById(select.id) || $(".searchbox input"))?.focus();
    } catch (error) {
      select.value = node.status;
      if (workspace === state.workspace) message(error.message, true);
    } finally {
      select.disabled = false;
    }
  };
  stage.append(select);
  return stage;
}

function drawLanes() {
  const board = $("#board-results");
  const query = state.query.trim().toLowerCase();
  const work = graph.nodes.filter(node => node.kind === "work" &&
    [key(node), node.title, node.description, node.assignee].join(" ").toLowerCase().includes(query) &&
    (state.filter === "all" || (state.filter === "mine" && settings.actor?.name && node.assignee?.trim().toLowerCase() === settings.actor.name.trim().toLowerCase()) || (state.filter === "blocked" && isBlocked(node)) ||
     (state.filter === "attention" && needsAttention(node)) ||
     (state.filter === "unassigned" && !node.assignee) ||
     (state.filter === "linked" && relationList(node).length) ||
     (state.filter === "unlinked" && !relationList(node).length)));
  const filtered = Boolean(query || state.filter !== "all");
  const presets = $("#saved-filters");
  if (presets) {
    const selected = (graph.saved_filters || []).find(item => item.id === state.savedFilter);
    if (selected?.query !== state.query.trim() || selected?.scope !== state.filter) state.savedFilter = "";
    presets.value = state.savedFilter || "";
    $("#save-filter").hidden = !filtered || Boolean(state.savedFilter);
    $("#delete-filter").hidden = !state.savedFilter;
  }
  const total = graph.nodes.filter(node => node.kind === "work").length;
  $("#view-count").textContent = filtered ? work.length + " of " + total : total;
  $("#clear-board").hidden = !filtered;
  board.className = state.layout === "board" ? "board" : "work-list";
  for (const toggle of document.querySelectorAll("[data-layout]")) {
    toggle.setAttribute("aria-pressed", String(toggle.dataset.layout === state.layout));
  }
  board.replaceChildren();
  if (!work.length && filtered) {
    board.append(el("p", "No items match these filters.", "result-empty"));
    return;
  }
  if (state.layout === "list") {
    for (const node of work) {
      const row = el("div", null, "issue-row");
      const title = button("", "issue-name", () => showDetails(node.id));
      title.append(el("span", key(node), "key"), el("strong", node.title));
      row.append(title, listStatus(node), el("span", node.assignee || "Unassigned", "row-owner"));
      board.append(row);
    }
    if (!work.length) board.append(el("p", "No work items yet.", "result-empty"));
    return;
  }
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

function personalFilters() {
  const group = el("div", null, "personal-filters");
  const stored = graph.saved_filters || [];
  const select = selector([["", "Saved filters"], ...stored.map(item => [item.id, item.name])], "Saved filters");
  select.id = "saved-filters";
  select.hidden = !stored.length;
  select.onchange = () => {
    const selected = stored.find(item => item.id === select.value);
    state.savedFilter = selected?.id || "";
    state.query = selected?.query || "";
    state.filter = selected?.scope || "all";
    $(".searchbox input").value = state.query;
    $(".filterbox select").value = state.filter;
    drawLanes();
  };
  function editFilter(remove) {
    const workspace = state.workspace;
    const selected = stored.find(item => item.id === select.value);
    if (remove && !selected) return;
    const content = showDialog(remove ? "Delete saved filter" : "Save filter");
    const form = el("form", null, "detail-block");
    const name = textInput("Filter name");
    name.maxLength = 80;
    if (remove) form.append(el("p", "Delete “" + selected.name + "” from your saved filters?", "detail-info"));
    else {
      form.append(field("Name", "name", name), el("p", [$(".filterbox select").selectedOptions[0].textContent, state.query.trim()]
        .filter(Boolean).join(" · "), "detail-info"));
    }
    const actions = el("div", null, "form-actions");
    const submit = el("button", remove ? "Delete filter" : "Save filter", "btn primary");
    const feedback = el("p", "", "dialog-error");
    feedback.setAttribute("role", "alert");
    actions.append(button("Cancel", "btn", () => $("#dialog").close()), submit);
    form.append(feedback, actions);
    form.onsubmit = async event => {
      event.preventDefault();
      if (submit.disabled) return;
      submit.disabled = true;
      try {
        const result = remove
          ? await request(workspace, "/saved-filters/" + selected.id, "DELETE")
          : await request(workspace, "/saved-filters", "POST", {name: name.value, query: state.query.trim(), scope: state.filter});
        if (workspace !== state.workspace) return;
        if (form.isConnected && $("#dialog").open) $("#dialog").close();
        state.savedFilter = remove ? "" : result.id;
        try {
          await load(workspace);
          const restored = $("#saved-filters");
          if (restored && !restored.hidden) restored.focus();
          else $(".searchbox input")?.focus();
          message(remove ? "Saved filter deleted." : "Filter saved.");
        } catch { message("Filter change saved. Reload to refresh your saved filters.", true); }
      } catch (error) { feedback.textContent = error.message; }
      finally { submit.disabled = false; }
    };
    content.append(form);
    (remove ? actions.firstChild : name).focus();
  }
  const save = button("Save filter", "text-btn", () => editFilter(false));
  save.id = "save-filter";
  const remove = button("Delete saved filter", "text-btn", () => editFilter(true));
  remove.id = "delete-filter";
  group.append(select, save, remove);
  return group;
}

function renderBoard(content) {
  const board = el("div", null, "board");
  const workspace = state.workspace;
  let draggedCard;
  let moving = false;

  function clearDrag() {
    draggedCard?.classList.remove("dragging");
    draggedCard = undefined;
    board.querySelectorAll(".drop-allowed, .drop-target").forEach(lane => {
      lane.classList.remove("drop-allowed", "drop-target");
    });
  }

  board.addEventListener("dragstart", event => {
    const card = event.target.closest(".card");
    if (!card || moving) {
      event.preventDefault();
      return;
    }
    draggedCard = card;
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", card.dataset.workId);
    card.classList.add("dragging");
    const targets = graph.transitions[nodes.get(card.dataset.workId).status] || [];
    board.querySelectorAll(".lane").forEach(lane => {
      lane.classList.toggle("drop-allowed", targets.includes(lane.dataset.status));
    });
  });
  board.addEventListener("dragend", clearDrag);
  board.addEventListener("dragover", event => {
    if (!draggedCard) return;
    const target = event.target.closest(".drop-allowed");
    board.querySelector(".drop-target")?.classList.remove("drop-target");
    if (!target) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    target.classList.add("drop-target");
  });
  board.addEventListener("dragleave", event => {
    const lane = event.target.closest(".drop-target");
    if (lane && !lane.contains(event.relatedTarget)) lane.classList.remove("drop-target");
  });
  board.addEventListener("drop", async event => {
    const target = event.target.closest(".drop-allowed");
    if (!draggedCard || !target) return;
    event.preventDefault();
    const id = draggedCard.dataset.workId;
    const status = target.dataset.status;
    clearDrag();
    moving = true;
    try {
      await moveWork(workspace, id, status);
    } catch (error) {
      message(error.message, true);
    } finally {
      moving = false;
    }
  });
  const controls = [searchControl(), filterControl()];
  if (mayEdit()) controls.push(button("New item", "btn primary", () => openForm("work"), "plus"));
  board.id = "board-results";
  const options = el("div", null, "board-options");
  const layouts = el("div", null, "layout-switch");
  layouts.setAttribute("role", "group");
  layouts.setAttribute("aria-label", "Work item layout");
  for (const layout of ["board", "list"]) {
    const toggle = button(layout === "board" ? "Board" : "List", "", () => {
      state.layout = layout;
      try { localStorage.setItem("wefttrack.layout", layout); } catch { /* Optional preference. */ }
      drawLanes();
    }, layout);
    toggle.dataset.layout = layout;
    layouts.append(toggle);
  }
  const clear = button("Clear filters", "text-btn", () => {
    state.savedFilter = "";
    state.query = "";
    state.filter = "all";
    $(".searchbox input").value = "";
    $(".filterbox select").value = "all";
    drawLanes();
    $(".searchbox input").focus();
  });
  clear.id = "clear-board";
  options.append(layouts);
  if (settings.actor) options.append(personalFilters());
  options.append(clear);
  content.append(toolbar("Work items", 0, controls), options, board);
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

function liveClaim(node) {
  return claimsByItem.get(node.id);
}

function canPull(node) {
  const name = settings.actor?.name.toLowerCase();
  return node.status === "open" && !liveClaim(node) && !isBlocked(node) &&
    (!node.assignee || node.assignee.toLowerCase() === name);
}

function claimForm(claim, release) {
  const node = nodes.get(claim.item);
  const action = release ? "Release claim" : "Submit result";
  const content = showDialog(action);
  const form = el("form", null, "detail-block");
  form.append(el("strong", key(node) + " · " + node.title));
  if (release) {
    form.append(el("p", "Return this requirement to the ready queue and clear its owner.", "detail-info"));
  } else {
    const summary = el("textarea");
    summary.rows = 3;
    summary.maxLength = 4000;
    form.append(field("Result summary", "summary", summary),
      field("Change title", "title", textInput("Describe the delivered change")),
      field("Repository", "repository", textInput("e.g. weftgit:team/export")),
      field("Change ID", "external_id", textInput("e.g. pr:42")));
  }
  const error = el("p", "", "dialog-error");
  error.setAttribute("role", "alert");
  const submit = el("button", action, "btn primary");
  const buttons = el("div", null, "form-actions");
  buttons.append(button("Cancel", "btn", () => $("#dialog").close()), submit);
  form.append(error, buttons);
  form.onsubmit = event => {
    event.preventDefault();
    save(submit, "/claims/" + claim.id + (release ? "/release" : "/report"), "POST",
      Object.fromEntries(new FormData(form)), release ? "Claim released." : "Result linked and sent for review.", error);
  };
  content.append(form);
  form.querySelector("textarea,button")?.focus();
}

function quickCapture(workspace) {
  const draft = captureDrafts.get(workspace) || {title: "", token: crypto.randomUUID(), pending: false};
  captureDrafts.set(workspace, draft);
  const form = el("form", null, "quick-capture");
  form.setAttribute("aria-label", "Quick capture");
  const title = textInput("What needs to be done?");
  title.setAttribute("aria-label", "Requirement title");
  title.value = draft.title;
  title.required = true;
  title.disabled = draft.pending;
  title.oninput = () => {
    draft.title = title.value;
    draft.token = crypto.randomUUID();
    title.setCustomValidity("");
  };
  const submit = el("button", "Add requirement", "btn primary");
  const details = button("Add details", "text-btn capture-details", () => openForm("work", null, draft));
  details.setAttribute("aria-label", "New requirement – Add details");
  submit.disabled = details.disabled = draft.pending;
  const error = el("small", "", "capture-error");
  error.setAttribute("role", "alert");
  form.append(title, submit, details, error);
  form.onsubmit = async event => {
    event.preventDefault();
    if (draft.pending) return;
    const value = draft.title.trim();
    if (!value) {
      title.setCustomValidity("Enter a requirement title.");
      title.reportValidity();
      return;
    }
    title.disabled = submit.disabled = details.disabled = draft.pending = true;
    error.textContent = "";
    try {
      await request(workspace, "/work", "POST", {title: value, capture_token: draft.token});
      draft.title = "";
      draft.token = crypto.randomUUID();
      title.value = "";
      if (state.workspace !== workspace) return;
      try {
        await load(workspace);
        if (state.workspace === workspace) message("Requirement added.");
      } catch {
        if (state.workspace === workspace) message("Requirement saved. The queue could not refresh.", true);
      }
    } catch (failure) {
      const current = $(".quick-capture .capture-error");
      if (state.workspace === workspace && current) current.textContent = failure.message;
      else if (state.workspace === workspace) message(failure.message, true);
    } finally {
      draft.pending = false;
      if (captureDrafts.get(workspace) === draft && state.workspace === workspace) {
        const field = $(".quick-capture input");
        if (field) {
          field.value = draft.title;
          field.disabled = false;
          document.querySelectorAll(".quick-capture button").forEach(button => { button.disabled = false; });
          field.focus();
        }
      }
      title.disabled = submit.disabled = details.disabled = false;
    }
  };
  return form;
}

function queuePriority(node) {
  const workspace = state.workspace;
  const select = selector(Object.entries(priorities), "Priority for " + key(node));
  select.className = "queue-priority";
  select.dataset.priority = select.value = node.priority || "normal";
  select.id = "priority-" + node.id;
  select.onchange = async () => {
    select.disabled = true;
    try {
      await request(workspace, "/work/" + node.id, "PATCH", {priority: select.value});
      if (workspace === state.workspace) {
        try {
          await load(workspace);
          if (document.activeElement === document.body) document.getElementById(select.id)?.focus();
          message("Queue priority updated.");
        } catch { message("Priority saved. Reload to refresh the queue.", true); }
      }
    } catch (error) {
      select.value = node.priority || "normal";
      message(error.message, true);
    } finally { select.disabled = false; }
  };
  return select;
}

function renderRequirements(content) {
  const work = graph.nodes.filter(n => n.kind === "work");
  const priority = {urgent: 0, high: 1, normal: 2, low: 3};
  work.sort((a,b) => (priority[a.priority] ?? 2) - (priority[b.priority] ?? 2) || a.number - b.number);
  const mine = [...claimsByItem.values()].find(c => c.owner_id === settings.actor?.id);
  const workspace = state.workspace;
  const editable = mayEdit();
  function pullButton(node) {
    const pull = button(node ? "Claim" : "Claim next", node ? "btn" : "btn primary", async () => {
      pull.disabled = true;
      try {
        const result = await request(workspace, "/claims/next", "POST", node ? {item: node.id} : {});
        if (workspace === state.workspace) {
          await load(workspace);
          message("Claimed " + key(result.item) + " · " + result.item.title);
        }
      } catch (error) {
        message(error.message, true);
        if (workspace === state.workspace) await load(workspace).catch(() => {});
      } finally { pull.disabled = false; }
    }, node ? null : "arrow");
    if (node) pull.setAttribute("aria-label", "Claim " + key(node));
    return pull;
  }
  const ready = work.filter(canPull);
  if (editable) content.append(quickCapture(workspace));
  function group(label, items, emptyText, folded = false) {
    const box = el(folded ? "details" : "section", null, "queue-section");
    const head = el(folded ? "summary" : "h2", null, "queue-heading");
    head.append(el("span", label), el("span", items.length, "count"));
    if (items === ready && editable && !mine && ready.length) {
      const header = el("div", null, "queue-ready-header");
      header.append(head, pullButton());
      box.append(header);
    } else box.append(head);
    if (items === ready && items.length > 1) box.append(el("p", "Highest priority first · Oldest first within each priority", "queue-order"));
    if (!items.length) box.append(el("p", emptyText, "queue-empty"));
    for (const node of items) {
      const row = el("div", null, "queue-row");
      const left = el("div", null, "queue-title");
      const title = button("", "issue-name", () => showDetails(node.id));
      title.append(el("span", key(node), "key"), el("strong", node.title));
      const claim = liveClaim(node);
      const meta = el("small", null, "queue-meta");
      if (claim) meta.textContent = claim.owner_name + " · " + claim.source;
      else if (isBlocked(node)) {
        const blockers = relationList(node).filter(edge => edge.kind === "blocks" && edge.target === node.id && nodes.get(edge.source)?.status !== "done");
        meta.textContent = "Blocked by " + blockers.map(e => key(nodes.get(e.source))).join(", ");
      } else meta.textContent = [lanes[node.status], editable && items === ready ? "" : priorities[node.priority] || "Normal", node.assignee || "Unassigned"].filter(Boolean).join(" · ");
      left.append(title, meta);
      const actions = el("div", null, "actions");
      if (editable && items === ready) actions.append(queuePriority(node));
      if (claim && editable) {
        if (claim.owner_id === settings.actor.id) actions.append(button("Submit result", "btn primary", () => claimForm(claim, false)));
        if (claim.owner_id === settings.actor.id || ["owner","admin"].includes(settings.actor.role))
          actions.append(button("Release", "btn", () => claimForm(claim, true)));
      } else if (editable && !mine && canPull(node)) actions.append(pullButton(node));
      row.append(left, actions);
      box.append(row);
    }
    content.append(box);
  }
  if (mine) group("Your claim", [nodes.get(mine.item)], "");
  if (ready.length || !mine) {
    group("Ready to pull", ready, work.length ? "No requirements are ready to claim." : editable ? "Add your first requirement above." : "No requirements yet.");
  }
  if (!work.length && workspace === "local") {
    content.lastChild.append(button("Explore example project", "text-btn explore-example", () => selectWorkspace("example")));
  }
  const others = work.filter(node => node.status !== "done" && !canPull(node) && node.id !== mine?.item);
  if (others.length) group("In progress & waiting", others, "");
  const finished = work.filter(node => node.status === "done");
  if (finished.length) group("Completed", finished, "", true);
}

function renderMap(content) {
  content.append(toolbar("Workspace map", graph.nodes.length, mayEdit() ? [
    button("New item", "btn", () => openForm("work"), "plus"),
    button("New relationship", "btn primary", () => openForm("link", nodes.get(state.focus)), "link"),
  ] : []));
  if (!graph.nodes.length) {
    content.append(el("p", "Create a work item to start the map.", "empty"));
    return;
  }

  const storageKey = "wefttrack.map." + state.workspace;
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(storageKey)) || {}; } catch { /* Layout storage is optional. */ }
  const positions = new Map();
  const cards = new Map();
  const map = el("div", null, "map");
  const controls = el("div", null, "map-controls");
  const select = selector([["", "Find a task or change"], ...graph.nodes.map(node => [
    node.id, key(node) + " · " + node.title,
  ])], "Find a task or change");
  select.className = "select-control";
  const search = textInput("Filter by title, key or assignee");
  search.type = "search";
  search.className = "select-control map-search";
  search.setAttribute("aria-label", "Filter map by title, key or assignee");
  const stageFilter = selector([["all", "All stages"], ...Object.entries(lanes), ["change", "Code changes"]], "Filter map by stage");
  stageFilter.className = "select-control";
  const related = el("input");
  related.type = "checkbox";
  const relatedLabel = el("label", null, "map-related");
  relatedLabel.append(related, document.createTextNode(" Focus and neighbors"));
  const noMatches = el("p", "No matching items on the map.", "empty map-empty");
  noMatches.hidden = true;
  const scroll = el("div", null, "map-scroll");
  scroll.tabIndex = 0;
  scroll.setAttribute("aria-label", "Workspace map canvas");
  const surface = el("div", null, "map-surface");
  const stage = el("div", null, "map-stage");
  const wires = svg("svg", { class: "map-wires", "aria-hidden": "true" });
  const defs = svg("defs", {});
  wires.append(defs);
  const colors = { parent_of: "#587a62", blocks: "#ac5637", implements: "#4876a0" };
  for (const [kind, fill] of Object.entries(colors)) {
    const marker = svg("marker", { id: "map-arrow-" + kind, viewBox: "0 0 8 8",
      refX: "7", refY: "4", markerWidth: "6", markerHeight: "6", orient: "auto" });
    marker.append(svg("path", { d: "M0 0L8 4L0 8Z", fill }));
    defs.append(marker);
  }
  const lines = graph.edges.map(edge => {
    const path = svg("path", { stroke: colors[edge.kind], "stroke-width": "2", fill: "none",
      "marker-end": "url(#map-arrow-" + edge.kind + ")" });
    wires.append(path);
    return { edge, path };
  });
  stage.append(wires);
  surface.append(stage);
  scroll.append(surface);

  let zoom = 1;
  let width = 1100;
  let height = 600;
  const zoomLabel = el("span", "100%", "map-zoom");
  function draw() {
    stage.style.width = width + "px";
    stage.style.height = height + "px";
    stage.style.transform = "scale(" + zoom + ")";
    surface.style.width = width * zoom + "px";
    surface.style.height = height * zoom + "px";
    for (const { edge, path } of lines) {
      const from = positions.get(edge.source), to = positions.get(edge.target);
      const a = cards.get(edge.source), b = cards.get(edge.target);
      const ax = from.x + a.offsetWidth / 2, ay = from.y + a.offsetHeight / 2;
      const bx = to.x + b.offsetWidth / 2, by = to.y + b.offsetHeight / 2;
      if (Math.abs(bx - ax) >= Math.abs(by - ay)) {
        const direction = bx >= ax ? 1 : -1;
        const x1 = ax + direction * a.offsetWidth / 2;
        const x2 = bx - direction * (b.offsetWidth / 2 + 2);
        const mid = (x1 + x2) / 2;
        path.setAttribute("d", `M${x1} ${ay} C${mid} ${ay} ${mid} ${by} ${x2} ${by}`);
      } else {
        const direction = by >= ay ? 1 : -1;
        const y1 = ay + direction * a.offsetHeight / 2;
        const y2 = by - direction * (b.offsetHeight / 2 + 2);
        const mid = (y1 + y2) / 2;
        path.setAttribute("d", `M${ax} ${y1} C${ax} ${mid} ${bx} ${mid} ${bx} ${y2}`);
      }
    }
  }

  function persist() {
    try { localStorage.setItem(storageKey, JSON.stringify(saved)); } catch { /* Layout storage is optional. */ }
  }

  function place(id, x, y) {
    positions.set(id, { x, y });
    const card = cards.get(id);
    card.style.left = x + "px";
    card.style.top = y + "px";
  }

  function arrange() {
    width = 1100;
    height = 600;
    const rows = new Map();
    for (const node of graph.nodes) {
      const column = node.kind === "change" ? 0 : Object.keys(lanes).indexOf(node.status) + 1;
      const row = rows.get(column) || 0;
      rows.set(column, row + 1);
      const point = saved[node.id];
      const x = Number.isFinite(point?.x) ? Math.max(0, point.x) : 32 + column * 236;
      const y = Number.isFinite(point?.y) ? Math.max(0, point.y) : 30 + row * 132;
      place(node.id, x, y);
      width = Math.max(width, x + 236);
      height = Math.max(height, y + 150);
    }
    draw();
  }

  function highlight(id, center = false) {
    state.focus = id;
    select.value = id;
    for (const [key, card] of cards) card.classList.toggle("focus", key === id);
    for (const { edge, path } of lines) {
      path.style.opacity = !id || edge.source === id || edge.target === id ? "1" : ".35";
    }
    applyFilters();
    if (center && cards.has(id)) {
      const point = positions.get(id), card = cards.get(id);
      scroll.scrollTo({
        left: (point.x + card.offsetWidth / 2) * zoom - scroll.clientWidth / 2,
        top: (point.y + card.offsetHeight / 2) * zoom - scroll.clientHeight / 2,
      });
    }
  }

  function applyFilters() {
    related.disabled = !state.focus;
    const neighbors = new Set([state.focus]);
    if (related.checked && state.focus) {
      for (const edge of adjacent.get(state.focus) || []) {
        neighbors.add(edge.source);
        neighbors.add(edge.target);
      }
    }
    const query = search.value.trim().toLocaleLowerCase();
    const visible = new Set();
    for (const node of graph.nodes) {
      const stageMatches = stageFilter.value === "all" ||
        stageFilter.value === (node.kind === "change" ? "change" : node.status);
      const textMatches = [key(node), node.title, node.assignee, node.repository].join(" ").toLocaleLowerCase().includes(query);
      const show = stageMatches && textMatches && (!related.checked || !state.focus || neighbors.has(node.id));
      cards.get(node.id).hidden = !show;
      if (show) visible.add(node.id);
    }
    for (const { edge, path } of lines) {
      path.style.display = visible.has(edge.source) && visible.has(edge.target) ? "" : "none";
    }
    $("#view-count").textContent = visible.size;
    noMatches.hidden = visible.size > 0;
    scroll.hidden = visible.size === 0;
    draw();
  }

  for (const node of graph.nodes) {
    let drag;
    let suppressClick = false;
    const card = button("", "map-node", () => {
      if (suppressClick) return;
      highlight(node.id);
      showDetails(node.id);
    });
    const caption = node.kind === "work"
      ? lanes[node.status] + " · " + (node.assignee || "Unassigned")
      : "Code change · " + node.repository;
    card.append(el("span", key(node), "key"), el("b", node.title), el("small", caption));
    card.title = node.title + " — " + caption;
    card.addEventListener("pointerdown", event => {
      if (event.button !== 0 || !event.isPrimary) return;
      suppressClick = false;
      drag = { id: event.pointerId, x: event.clientX, y: event.clientY, origin: positions.get(node.id) };
      card.setPointerCapture(event.pointerId);
    });
    card.addEventListener("pointermove", event => {
      if (drag?.id !== event.pointerId) return;
      const dx = event.clientX - drag.x, dy = event.clientY - drag.y;
      if (!suppressClick && Math.hypot(dx, dy) < 5) return;
      suppressClick = true;
      card.classList.add("map-dragging");
      place(node.id, Math.max(0, Math.min(width - card.offsetWidth, drag.origin.x + dx / zoom)),
        Math.max(0, Math.min(height - card.offsetHeight, drag.origin.y + dy / zoom)));
      draw();
    });
    card.addEventListener("lostpointercapture", () => {
      if (drag && suppressClick) {
        saved[node.id] = positions.get(node.id);
        persist();
        highlight(node.id);
      }
      drag = undefined;
      card.classList.remove("map-dragging");
    });
    card.addEventListener("click", event => {
      if (event.detail === 0) suppressClick = false;
    }, true);
    card.addEventListener("keydown", event => {
      const shift = { ArrowLeft: [-24, 0], ArrowRight: [24, 0], ArrowUp: [0, -24], ArrowDown: [0, 24] }[event.key];
      if (!event.altKey || !shift) return;
      event.preventDefault();
      const point = positions.get(node.id);
      place(node.id, Math.max(0, Math.min(width - card.offsetWidth, point.x + shift[0])),
        Math.max(0, Math.min(height - card.offsetHeight, point.y + shift[1])));
      saved[node.id] = positions.get(node.id);
      persist();
      highlight(node.id, true);
      draw();
    });
    card.setAttribute("aria-keyshortcuts", "Alt+ArrowLeft Alt+ArrowRight Alt+ArrowUp Alt+ArrowDown");
    cards.set(node.id, card);
    stage.append(card);
  }

  let pan;
  stage.addEventListener("pointerdown", event => {
    if (event.target !== stage || event.button !== 0 || !event.isPrimary) return;
    pan = { id: event.pointerId, x: event.clientX + scroll.scrollLeft, y: event.clientY + scroll.scrollTop };
    stage.setPointerCapture(event.pointerId);
    stage.classList.add("map-panning");
  });
  stage.addEventListener("pointermove", event => {
    if (event.target === stage && pan?.id === event.pointerId) {
      scroll.scrollTo(pan.x - event.clientX, pan.y - event.clientY);
    }
  });
  stage.addEventListener("lostpointercapture", event => {
    if (event.target !== stage) return;
    pan = undefined;
    stage.classList.remove("map-panning");
  });

  function setZoom(next) {
    const x = (scroll.scrollLeft + scroll.clientWidth / 2) / zoom;
    const y = (scroll.scrollTop + scroll.clientHeight / 2) / zoom;
    zoom = Math.max(.25, Math.min(1.5, next));
    zoomLabel.textContent = Math.round(zoom * 100) + "%";
    draw();
    scroll.scrollTo(x * zoom - scroll.clientWidth / 2, y * zoom - scroll.clientHeight / 2);
  }

  search.oninput = stageFilter.onchange = related.onchange = () => {
    applyFilters();
    fitMap();
  };
  select.onchange = () => {
    search.value = "";
    stageFilter.value = "all";
    highlight(select.value, true);
  };
  function fitMap() {
    const visible = [...cards].filter(([, card]) => !card.hidden);
    if (!visible.length) return;
    let left = Infinity, top = Infinity, right = 0, bottom = 0;
    for (const [id, card] of visible) {
      const { x, y } = positions.get(id);
      left = Math.min(left, x);
      top = Math.min(top, y);
      right = Math.max(right, x + card.offsetWidth);
      bottom = Math.max(bottom, y + card.offsetHeight);
    }
    setZoom(Math.min(scroll.clientWidth / (right - left + 48), scroll.clientHeight / (bottom - top + 48), 1));
    scroll.scrollTo(Math.max(0, left - 24) * zoom, Math.max(0, top - 24) * zoom);
  }
  controls.append(select, search, stageFilter, relatedLabel, button("Zoom out", "btn", () => setZoom(zoom - .15)), zoomLabel,
    button("Zoom in", "btn", () => setZoom(zoom + .15)),
    button("Fit map", "btn", fitMap),
    button("Reset layout", "btn", () => {
      saved = {};
      persist();
      arrange();
      highlight(state.focus, true);
    }));
  const legend = el("div", null, "map-legend");
  for (const [kind, label] of Object.entries({ parent_of: "Parent → child", blocks: "Blocks", implements: "Implements" })) {
    const item = el("span", label);
    item.style.setProperty("--edge-color", colors[kind]);
    legend.append(item);
  }
  map.append(controls, noMatches, scroll, legend);
  content.append(map);
  arrange();
  fitMap();
  if (state.focus) highlight(state.focus, true);
  else applyFilters();
  mapObserver = new ResizeObserver(draw);
  for (const card of cards.values()) mapObserver.observe(card);

  const section = el("details", null, "section-spacer");
  section.append(el("summary", "Relationships (" + graph.edges.length + ")"),
    relationshipRows(graph.edges, "No relationships yet."));
  content.append(section);
}

function renderChanges(content) {
  const changes = graph.nodes.filter(n => n.kind === "change");
  const feed = el("div", null, "panel hosted-feed");
  const refresh = button("Refresh commits", "btn", readCommits);
  content.append(toolbar("WeftGit commits", 0, [refresh]), feed);
  const commitCount = $("#view-count");
  readCommits();

  async function readCommits() {
    refresh.disabled = true;
    feed.replaceChildren(el("p", "Reading WeftGit repositories…", "empty"));
    try {
      const { connected, repositories } = await request(state.workspace, "/weftgit");
      if (!feed.isConnected) return;
      commitCount.textContent = repositories.reduce((count, repo) => count + repo.commits.length, 0);
      feed.replaceChildren();
      if (!connected || !repositories.length) {
        feed.append(el("p", connected ? "Create a repository in WeftGit and push a commit to see it here." :
          "The local WeftGit repository directory could not be found.", "empty"));
      }
      for (const repo of repositories) {
        const section = el("section", null, "hosted-repo");
        const heading = el("h3");
        const repoLink = el("a", repo.name);
        repoLink.href = "http://127.0.0.1:8091/hosted?" + new URLSearchParams({ repo: repo.name, view: "source" });
        repoLink.title = "Browse " + repo.name + " in WeftGit";
        heading.append(repoLink);
        section.append(heading);
        if (!repo.commits.length) section.append(el("p", repo.error || "No commits pushed yet.", "detail-info"));
        for (const commit of repo.commits) {
          const title = commit.title || "Untitled commit";
          const row = el("div", null, "hosted-commit");
          const text = el("div");
          const date = new Date(commit.date);
          const caption = commit.sha.slice(0, 8) + (Number.isNaN(date.valueOf()) ? "" : " · " + date.toLocaleDateString());
          text.append(el("strong", title), el("small", caption));
          const change = changes.find(node => node.repository === "weftgit:" + repo.name &&
            node.external_id === "commit:" + commit.sha);
          if (change) {
            const linked = el("div", null, "actions");
            for (const edge of relationList(change)) {
              if (edge.kind === "implements") linked.append(entityButton(nodes.get(edge.target)));
            }
            text.append(linked);
          }
          row.append(text);
          if (mayEdit()) row.append(button("Link task", "btn", () => linkHostedCommit(repo.name, commit), "link"));
          section.append(row);
        }
        feed.append(section);
      }
    } catch (error) {
      feed.replaceChildren(el("p", error.message, "empty"));
    } finally {
      refresh.disabled = false;
    }
  }

  const registry = el("section", null, "section-spacer");
  registry.append(sectionHeading("Tracked changes",
    mayEdit() ? button("Register change manually", "btn", () => openForm("change"), "plus") : null));
  const panel = el("div", null, "registry");
  const head = el("div", null, "registry-row head");
  head.append(el("span", "Code change"), el("span", "Repository"), el("span", "External ID"));
  panel.append(head);
  if (!changes.length) panel.append(el("p", "Register a code change to connect it to a work item.", "empty"));
  for (const item of changes) {
    const row = el("div", null, "registry-row");
    const hosted = item.repository.startsWith("weftgit:") && item.external_id.startsWith("commit:");
    const external = el("span", hosted ? item.external_id.slice(7, 15) : item.external_id, "key");
    external.title = item.external_id;
    row.append(entityButton(item), el("span", item.repository), external);
    panel.append(row);
  }
  registry.append(panel);
  content.append(registry);
}

function linkHostedCommit(repository, commit) {
  const content = showDialog("Link commit to task");
  content.append(el("p", commit.title || "Commit " + commit.sha.slice(0, 8), "detail-info"));
  const work = graph.nodes.filter(node => node.kind === "work");
  if (!work.length) {
    content.append(el("p", "Create a work item before linking this commit.", "detail-info"),
      button("New item", "btn", () => openForm("work"), "plus"));
    return;
  }
  const form = el("form", null, "detail-block");
  const target = selector([["", "Choose a task"], ...work.map(node => [node.id, key(node) + " · " + node.title])], "Task");
  const keys = new Set((commit.title.toUpperCase().match(/\bWT-\d+\b/g) || []));
  const matches = work.filter(node => keys.has(key(node)));
  if (matches.length === 1) target.value = matches[0].id;
  const errorBox = el("p", "", "dialog-error");
  errorBox.setAttribute("role", "alert");
  const submit = el("button", "Link commit", "btn primary");
  form.append(field("Task", "target", target), errorBox, submit);
  form.onsubmit = event => {
    event.preventDefault();
    save(submit, "/weftgit/links", "POST", { repository, sha: commit.sha, target: target.value },
      "Commit linked to task.", errorBox);
  };
  content.append(form);
}

function renderEffort(content) {
  const groups = new Map();
  for (const node of graph.nodes) {
    if (node.kind !== "work") continue;
    const name = node.assignee || "";
    const id = name.toLocaleLowerCase();
    if (!groups.has(id)) {
      groups.set(id, { name, open: 0, active: 0, done: 0, remaining: [0, 0], completed: [0, 0] });
    }
    const group = groups.get(id);
    const done = node.status === "done";
    group[done ? "done" : node.status === "open" ? "open" : "active"]++;
    const total = done ? group.completed : group.remaining;
    const [low, high] = itemEstimate(node);
    total[0] += low;
    total[1] += high;
  }

  content.append(sectionHeading("Effort by assignee"));
  if (!groups.size) {
    content.append(el("p", "Create work items to see effort by assignee.", "empty"));
    return;
  }

  const statuses = { open: "Open", active: "In flight", done: "Done" };
  function statusChart(counts) {
    const chart = el("div", null, "effort-status");
    const track = el("div", null, "effort-status-track");
    track.setAttribute("aria-hidden", "true");
    const labels = el("div", null, "effort-status-labels");
    for (const [key, label] of Object.entries(statuses)) {
      if (counts[key]) {
        const segment = el("span", null, "effort-tone-" + key);
        segment.style.flexGrow = counts[key];
        track.append(segment);
      }
      const item = el("span", counts[key] + " " + label.toLowerCase(), "effort-tone-" + key);
      labels.append(item);
    }
    chart.append(track, labels);
    return chart;
  }

  const ordered = [...groups.values()].sort((a, b) => Number(!a.name) - Number(!b.name) || a.name.localeCompare(b.name));
  const totals = { open: 0, active: 0, done: 0 };
  let maxHours = 0;
  for (const group of ordered) {
    for (const key of Object.keys(statuses)) totals[key] += group[key];
    maxHours = Math.max(maxHours, group.remaining[1], group.completed[1]);
  }
  const scale = maxHours > 10 ? Math.ceil(maxHours / 10) * 10 : maxHours;

  function estimateBar(label, range, tone) {
    const row = el("div", null, "effort-estimate " + tone);
    const caption = el("div", null, "effort-estimate-caption");
    caption.append(el("span", label), el("strong", formatEffort(range)));
    const track = el("div", null, "effort-estimate-track");
    track.setAttribute("aria-hidden", "true");
    const upper = el("span", null, "effort-estimate-upper");
    const lower = el("span", null, "effort-estimate-lower");
    upper.style.width = (range[1] / scale * 100) + "%";
    lower.style.width = (range[0] / scale * 100) + "%";
    track.append(upper, lower);
    row.append(caption, track);
    return row;
  }

  const overview = el("section", null, "panel effort-overview");
  const overviewTitle = el("div", null, "effort-overview-title");
  const percent = Math.round(totals.done / (totals.open + totals.active + totals.done) * 100);
  overviewTitle.append(el("h3", "Workspace progress"), el("strong", percent + "% done"));
  overview.append(overviewTitle, statusChart(totals));
  const guide = el("p", "Estimated hours share a 0–" + scale +
    " h scale. Stripes show the gap between the lower and upper estimates. In flight includes review.", "effort-guide");
  const grid = el("div", null, "effort-grid");
  for (const group of ordered) {
    const card = el("section", null, "panel effort-person");
    const heading = el("div", null, "effort-person-heading");
    const total = group.open + group.active + group.done;
    heading.append(el("h3", group.name || "Unassigned"), el("span", total + (total === 1 ? " task" : " tasks")));
    card.append(heading, statusChart(group),
      estimateBar("Unfinished estimate", group.remaining, "effort-tone-active"),
      estimateBar("Completed estimate", group.completed, "effort-tone-done"));
    grid.append(card);
  }
  content.append(overview, guide, grid);
}

function settingsDialog(title, action, fields, path, method, onSaved) {
  const content = showDialog(title);
  const form = el("form", null, "detail-block");
  const error = el("p", null, "dialog-error");
  error.setAttribute("role", "alert");
  const submit = el("button", action, "btn primary");
  form.append(...fields, error, submit);
  form.onsubmit = async event => {
    event.preventDefault();
    submit.disabled = true;
    error.textContent = "";
    try {
      const body = Object.fromEntries(new FormData(form));
      const result = await request("local", path, method, body);
      $("#dialog").close();
      await onSaved(result);
    } catch (failure) {
      if ($("#dialog").open) error.textContent = failure.message;
      else message(failure.message, true);
    } finally {
      submit.disabled = false;
    }
  };
  content.append(form);
}

function showAccessCode(title, code) {
  const content = showDialog(title);
  const input = textInput("");
  input.value = code;
  input.readOnly = true;
  content.append(el("p", "Save this access code. It is shown once and is used to sign in.", "detail-info"),
    field("Access code", "code", input, false));
  const copy = button("Copy access code", "btn", async () => {
    try { await navigator.clipboard.writeText(code); copy.textContent = "Copied"; }
    catch { input.focus(); input.select(); }
  });
  content.append(copy);
  input.focus();
  input.select();
}

async function refreshSettings() {
  await loadSettings();
  if (!Object.hasOwn(workspaces, state.workspace)) await load("local");
  else render();
}

function signInDialog() {
  const code = textInput("");
  code.type = "password";
  code.autocomplete = "current-password";
  settingsDialog("Sign in", "Sign in", [field("Access code", "code", code)], "/access", "POST", startWorkspace);
}

async function showCreatedCode(title, code) {
  showAccessCode(title, code);
  try { await refreshSettings(); }
  catch { message("Access code created. Reload to refresh the user list after saving the code.", true); }
}

function setupOwner() {
  settingsDialog("Set up owner access", "Create owner code", [field("Your name", "name", textInput(""))],
    "/setup", "POST", ({code}) => showCreatedCode("Owner access code", code));
}

async function signOut() {
  try {
    await request("local", "/access", "DELETE");
    ++loading;
    captureDrafts.clear();
    claimsByItem.clear();
    Object.assign(state, {focus: null, query: "", filter: "all"});
    graph = { nodes: [], edges: [], transitions: {} };
    nodes.clear();
    adjacent.clear();
    await startWorkspace();
  } catch (error) { message(error.message, true); }
}

function renderSettings(content) {
  const actor = settings.actor;
  const access = el("section", null, "panel settings-panel");
  if (!actor) {
    access.append(el("h2", "Sign in"), button("Enter access code", "btn primary", signInDialog));
    content.append(access);
    return;
  }
  access.append(el("h2", actor.name + " · " + roles[actor.role]));
  if (settings.configured) access.append(button("Sign out", "btn", signOut));
  else access.append(button("Set up team access", "btn primary", setupOwner));
  content.append(access);

  const canManage = actor.role === "owner" || actor.role === "admin";
  const projects = el("section", null, "section-spacer");
  const projectPanel = el("div", null, "panel settings-panel");
  function projectForm(project) {
    const input = textInput("Project name");
    input.value = project?.name || "";
    settingsDialog(project ? "Rename project" : "New project", "Save project", [field("Name", "name", input)],
      project ? "/project-settings/" + project.id : "/projects", project ? "PATCH" : "POST", refreshSettings);
  }
  projects.append(sectionHeading("Project boards", canManage ? button("New project", "btn primary", () => projectForm(), "plus") : null), projectPanel);
  const projectRows = [{ id: "local", name: workspaces.local }, ...settings.projects];
  for (const project of projectRows) {
    const row = el("div", null, "settings-row");
    const actions = el("div", null, "actions");
    row.append(el("strong", project.name + (project.archived ? " · Archived" : "")), actions);
    if (!project.archived) actions.append(button("Open board", "btn", async () => {
      if (await selectWorkspace(project.id)) location.hash = "board";
    }));
    if (canManage && project.id !== "local") {
      actions.append(button("Rename", "btn", () => projectForm(project)),
        button(project.archived ? "Restore" : "Archive", "btn", async () => {
          try {
            await request("local", "/project-settings/" + project.id, "PATCH", { archived: !project.archived });
            await refreshSettings();
          } catch (error) { message(error.message, true); }
        }));
    }
    projectPanel.append(row);
  }
  content.append(projects);

  const directory = el("a", "Open user directory", "btn");
  directory.href = "#users";
  content.append(directory);
}

function renderUsers(content) {
  const actor = settings.actor;
  if (!actor) {
    content.append(el("p", "Sign in to view users.", "detail-info"), button("Sign in", "btn primary", signInDialog));
    return;
  }
  if (!settings.configured) {
    const setup = el("section", null, "panel settings-panel");
    setup.append(el("h2", "Set up user accounts"), el("p", "Create your owner account to add users and manage access.", "detail-info"),
      button("Set up owner account", "btn primary", setupOwner));
    content.append(setup);
    return;
  }
  const account = el("div", null, "actions");
  account.append(el("span", "Signed in as " + actor.name + " · " + roles[actor.role], "detail-info"),
    button("Sign out", "btn", signOut));
  content.append(account);
  const canManage = ["owner", "admin"].includes(actor.role);
  const team = el("section");
  const teamPanel = el("div", null, "panel settings-panel");
  function memberForm(member) {
    const input = textInput("User name");
    input.value = member?.name || "";
    const roleChoices = actor.role === "owner" ? ["editor", "viewer", "admin"] : ["editor", "viewer"];
    const role = selector(roleChoices.map(key => [key, roles[key]]), "Role");
    role.value = member?.role || "editor";
    settingsDialog(member ? "Edit user" : "Create user", member ? "Save changes" : "Create user",
      [field("Name", "name", input), field("Role", "role", role)],
      member ? "/members/" + member.id : "/members", member ? "PATCH" : "POST", async ({ code }) => {
        if (code) await showCreatedCode("User access code", code);
        else await refreshSettings();
      });
  }
  const addMember = canManage ? button("Create user", "btn primary", () => memberForm(), "plus") : null;
  team.append(sectionHeading("User directory", addMember), teamPanel);
  teamPanel.append(el("p", "Roles apply to all projects. Owners manage admins, admins manage editors and viewers, editors can change work, and viewers can read it.", "detail-info"));
  for (const member of settings.members) {
    const row = el("div", null, "settings-row");
    const actions = el("div", null, "actions");
    row.append(el("strong", member.name + " · " + roles[member.role]), actions);
    if (canManage && member.role !== "owner" && (actor.role === "owner" || member.role !== "admin")) {
      actions.append(button("Edit", "btn", () => memberForm(member)), button("Remove", "btn", () => {
        const notice = el("p", member.name + " will lose access to WeftTrack.", "detail-info");
        settingsDialog("Remove user", "Remove access", [notice], "/members/" + member.id, "DELETE", refreshSettings);
      }));
    }
    teamPanel.append(row);
  }
  content.append(team);
}

function render() {
  mapObserver?.disconnect();
  state.view = getView();
  const name = views[state.view];
  document.title = name + " · WeftTrack";
  $("#page-title").textContent = $("#crumb-view").textContent = name;
  $("#crumb-space").textContent = state.view === "users" ? "All projects" : workspaces[state.workspace];
  $("#project").textContent = state.view === "users" ? "All projects" : state.workspace === "example" ? "Export release · Example project" : workspaces[state.workspace];
  const summary = $("#summary");
  summary.replaceChildren();
  const work = graph.nodes.filter(node => node.kind === "work");
  const metrics = state.view === "requirements"
    ? [[work.filter(canPull).length, "ready to pull"], [claimsByItem.size, "active claim"]]
    : state.view === "board"
    ? [[work.length, "work item"], [work.filter(node => node.status === "done").length, "completed"],
      [work.filter(needsAttention).length, "need attention"]]
    : [[work.length, "work item"], [graph.edges.length, "relationship"], [graph.nodes.length - work.length, "code change"]];
  for (const [count, title] of ["settings", "users"].includes(state.view) ? [] : metrics) {
    const item = el("span");
    const label = { "ready to pull": "ready to pull", completed: "completed", "need attention": count === 1 ? "needs attention" : "need attention" }[title];
    item.append(el("b", count), document.createTextNode(label || title + (count === 1 ? "" : "s")));
    summary.append(item);
  }
  document.querySelectorAll("[data-view]").forEach(a => {
    if (a.dataset.view === state.view) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  });
  const content = $("#content");
  content.replaceChildren();
  if (!settings.actor && state.workspace !== "example" && state.view !== "settings") {
    const access = el("div", null, "actions");
    access.append(button("Sign in", "btn primary", signInDialog),
      button("Explore example project", "btn", () => selectWorkspace("example")));
    content.append(el("p", "Sign in to open your workspace.", "empty"), access);
    return;
  }
  ({ board: renderBoard, requirements: renderRequirements, graph: renderMap, effort: renderEffort, changes: renderChanges, users: renderUsers, settings: renderSettings })[state.view](content);
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

async function save(control, path, method, body, success, errorBox, onConflict, onSaved) {
  const workspace = state.workspace;
  control.disabled = true;
  errorBox.textContent = "";
  try {
    await request(workspace, path, method, body);
    onSaved?.();
    if (workspace !== state.workspace) return;
    if (control.isConnected && $("#dialog").open) $("#dialog").close();
    try {
      await load(workspace);
      message(success);
    } catch {
      message(success + " Reload the page to refresh this view.", true);
    }
  } catch (error) {
    errorBox.textContent = error.message;
    if (error.conflicts && onConflict) onConflict(error.conflicts);
  } finally {
    control.disabled = false;
  }
}

function itemActivity(node) {
  const workspace = state.workspace;
  const path = "/work/" + node.id + "/activity";
  const section = el("section", null, "detail-block item-activity");
  section.append(el("h3", "Activity"));
  const feed = el("ol", null, "activity-events");
  const feedback = el("p", "Loading activity…", "detail-info");
  feedback.setAttribute("role", "status");
  function display(events) {
    feedback.textContent = events.length ? "" : "No activity recorded yet.";
    feed.replaceChildren();
    for (const event of events) {
      const entry = el("li");
      const time = el("time");
      time.dateTime = event.created.replace(" ", "T") + "Z";
      time.textContent = new Date(time.dateTime).toLocaleString(undefined, {dateStyle: "medium", timeStyle: "short"});
      entry.append(el("strong", event.actor), time, el("p", event.body));
      entry.className = event.kind;
      feed.append(entry);
    }
  }
  section.append(feedback);
  if (mayEdit()) {
    const form = el("form", null, "comment-form");
    const note = el("textarea");
    note.placeholder = "Leave a comment";
    note.setAttribute("aria-label", "Comment on " + key(node));
    note.rows = 2;
    note.maxLength = 4000;
    const submit = el("button", "Add comment", "btn");
    submit.type = "submit";
    submit.disabled = true;
    let token;
    note.oninput = () => { token = null; submit.disabled = !note.value.trim(); };
    form.onsubmit = async event => {
      event.preventDefault();
      if (!note.value.trim() || note.disabled) return;
      submit.disabled = note.disabled = true;
      token ||= crypto.randomUUID();
      try {
        const result = await request(workspace, path, "POST", {body: note.value, token});
        display(result.events);
        token = null;
        note.value = "";
      } catch (error) { feedback.textContent = error.message; }
      finally {
        note.disabled = false;
        submit.disabled = !note.value.trim();
        note.focus();
      }
    };
    form.append(note, submit);
    section.append(form);
  }
  section.append(feed);
  request(workspace, path).then(result => {
    if (!feed.childElementCount) display(result.events);
  }).catch(error => { feedback.textContent = error.message; });
  return section;
}

function taskBrief(node, permalink) {
  const claim = liveClaim(node);
  const lines = [key(node) + " · " + node.title, "Workspace: " + workspaces[state.workspace],
    "Status: " + lanes[node.status] + " · Priority: " + priorities[node.priority],
    "Owner: " + (claim?.owner_name || node.assignee || "Unassigned"),
    "Requirement: " + permalink.href];
  if (claim) lines.push("Active claim: " + claim.owner_name + " (" + claim.source + ")");
  const request = node.status === "review" || node.status === "done"
    ? "Review the linked changes against this requirement. Identify any gaps and suggest a concrete way to verify the result."
    : isBlocked(node) ? "Explain what is blocking this requirement and propose the next step to unblock it. Describe how to verify the eventual change."
    : "Propose a focused change for this requirement and a concrete way to verify it. Identify any missing information before implementation.";
  lines.unshift(request, "");
  if (node.description) lines.push("", node.description);
  const edges = relationList(node);
  if (edges.length) lines.push("", "Related work");
  for (const edge of edges) {
    const outgoing = edge.source === node.id;
    const other = nodes.get(outgoing ? edge.target : edge.source);
    const detail = other.kind === "change" ? other.repository + " / " + other.external_id : lanes[other.status];
    lines.push("• " + edgeLabels[edge.kind][outgoing ? 0 : 1] + ": " + key(other) + " · " + other.title + " (" + detail + ")");
  }
  return lines.join("\n");
}

function assistantTools(node, permalink) {
  const area = el("div", null, "assistant-tools");
  const copy = button("Copy task brief", "btn", async () => {
    const text = taskBrief(node, permalink);
    try {
      await navigator.clipboard.writeText(text);
      copy.textContent = "Brief copied";
    } catch {
      let field = area.querySelector("textarea");
      if (!field) {
        field = el("textarea");
        field.readOnly = true;
        field.rows = 6;
        field.setAttribute("aria-label", "Task brief to copy");
        area.append(field);
      }
      field.value = text;
      field.focus();
      field.select();
    }
  });
  const details = el("details", null, "task-commands");
  details.append(el("summary", "CLI & API"));
  const prefix = workspacePrefix(state.workspace);
  const cli = "python3 agent.py --workspace " + state.workspace;
  const endpoint = location.origin + prefix;
  const read = cli + " show " + node.id;
  const auth = ' -H "Authorization: Bearer $WEFTTRACK_ACCESS_CODE"';
  function command(label, snippet) {
    details.append(el("strong", label), el("pre", snippet));
  }
  const needsAuth = settings.configured && state.workspace !== "example";
  command("Read this requirement", read + "\n" + "curl" + (needsAuth ? auth : "") + " " + endpoint + "/work/" + node.id);
  const own = [...claimsByItem.values()].find(item => item.owner_id === settings.actor?.id);
  const claim = liveClaim(node);
  if (mayEdit() && settings.configured && canPull(node) && !own) {
    command("Claim this requirement", cli + " claim --item " + node.id);
    details.append(el("p", "Run with the editor’s own access code. WeftTrack checks eligibility when the command runs.", "detail-info"));
  } else if (mayEdit() && settings.configured && claim && claim.owner_id === settings.actor.id) {
    command("Submit your claim", cli + " report " + claim.id +
      ' --summary "RESULT SUMMARY" --repository "REPOSITORY" --external-id "CHANGE ID" --title "CHANGE TITLE"');
    details.append(el("p", "Use the claiming account’s access code and replace the example result fields.", "detail-info"));
  }
  if (needsAuth) details.append(el("p", "Set WEFTTRACK_ACCESS_CODE in the shell environment before running these commands.", "detail-info"));
  const handoff = el("div", null, "brief-handoff");
  handoff.append(copy, el("small", "Paste the brief into your coding assistant’s chat.", "detail-info"));
  area.append(handoff, details);
  return area;
}

function showDetails(id) {
  if (new URLSearchParams(location.search).get("item") === id) $("#dialog").dataset.linkedItem = id;
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
  if (node.kind === "change") {
    content.append(el("p", node.repository + " / " + node.external_id, "detail-info"));
    const repo = /^weftgit:([a-z0-9][a-z0-9_-]{0,63}\/[a-z0-9][a-z0-9_-]{0,63})$/i.exec(node.repository);
    const pr = /^pr:([1-9]\d*)$/.exec(node.external_id);
    if (repo && pr) {
      const review = el("a", "Open pull request #" + pr[1] + " in WeftGit", "btn");
      review.href = "http://127.0.0.1:8091/hosted?" + new URLSearchParams({ repo: repo[1], pr: pr[1] });
      content.append(review);
    }
  }
  if (node.kind === "work") {
    content.append(el("p", [workTypes[node.work_type], priorities[node.priority] + " priority",
      node.assignee || "Unassigned", formatEffort(itemEstimate(node)) + " estimated"].join(" · "), "detail-info"));
    if (node.description) content.append(el("p", node.description, "detail-info work-description"));
  }
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
  if (mayEdit()) linkActions.append(button("Link item", "btn", () => openForm("link", node), "link"));
  linkActions.append(button("Explore map", "btn", () => {
    $("#dialog").close(); state.focus = id;
    if (state.view === "graph") render(); else location.hash = "graph";
  }, "graph"));
  if (node.kind === "work" && mayEdit()) linkActions.prepend(button("Edit item", "btn", () => openForm("edit", node)));
  const permalink = new URL("/", location.origin);
  permalink.search = new URLSearchParams({ workspace: state.workspace, item: id });
  permalink.hash = "board";
  const copyLink = button("Copy item link", "btn", async () => {
    try {
      await navigator.clipboard.writeText(permalink.href);
      copyLink.textContent = "Link copied";
    } catch {
      const field = el("input");
      field.readOnly = true;
      field.value = permalink.href;
      field.setAttribute("aria-label", "Item link");
      linkActions.replaceChild(field, copyLink);
      field.select();
    }
  });
  linkActions.append(copyLink);
  content.append(linkActions);
  if (node.kind !== "work") return;
  content.append(assistantTools(node, permalink));
  if (!mayEdit()) {
    if (settings.actor) content.append(itemActivity(node));
    return;
  }
  const claim = liveClaim(node);
  if (claim) {
    content.append(el("p", "Claimed by " + claim.owner_name + " via " + claim.source + ".", "detail-info"),
      button("View requirements log", "btn", () => { $("#dialog").close(); location.hash = "requirements"; }),
      itemActivity(node));
    return;
  }
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
  content.append(actions, errorBox, itemActivity(node));
}

function field(label, name, control, required = true) {
  const wrap = el("div", null, "field");
  const caption = el("label", label);
  control.id = "form-" + name;
  caption.htmlFor = control.id;
  control.name = name;
  control.required = required;
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

function openForm(type, sourceNode, draft) {
  if (!mayEdit()) return;
  const configs = {
    work: ["New work item", "Create item", "/work", "POST", "Work item created."],
    edit: ["Edit work item", "Save changes", "/work/" + sourceNode?.id, "PATCH", "Work item updated."],
    link: ["New relationship", "Create relationship", "/links", "POST", "Relationship created."],
    change: ["Register code change", "Save change", "/changes", "PUT", "Code change saved."],
  };
  const [title, action, path, method, success] = configs[type];
  const content = showDialog(title);
  const form = el("form", null, "detail-block");
  form.style.gap = "15px";
  if (type === "link") linkFields(form, sourceNode);
  else if (type === "work" || type === "edit") {
    const title = textInput("What needs to be done?");
    const description = el("textarea");
    description.rows = 3;
    description.maxLength = 10000;
    const assignee = textInput("Unassigned");
    assignee.maxLength = 120;
    const team = el("datalist");
    team.id = "assignee-suggestions";
    team.append(...settings.members.map(member => new Option(member.name, member.name)));
    assignee.setAttribute("list", team.id);
    form.append(team);
    const workType = selector(Object.entries(workTypes), "Work type");
    const priority = selector(Object.entries(priorities), "Priority");
    const effort = selector([["auto", "Estimate from task text"], ...Object.entries(effortBands).map(([band, range]) =>
      [band, formatEffort(range)])], "Effort estimate");
    title.value = sourceNode?.title ?? draft?.title ?? "";
    description.value = sourceNode?.description ?? "";
    assignee.value = sourceNode?.assignee ?? "";
    if (sourceNode && liveClaim(sourceNode)) assignee.readOnly = true;
    workType.value = sourceNode?.work_type ?? "task";
    priority.value = sourceNode?.priority ?? "normal";
    effort.value = sourceNode?.effort_band ?? "auto";
    const suggestion = el("span", "", "detail-info");
    const useType = button("Use suggested type", "btn", () => {
      workType.value = suggestWork(title.value, description.value).type;
      updateSuggestion();
    });
    function updateSuggestion() {
      const text = title.value.trim() || description.value.trim();
      const proposed = suggestWork(title.value, description.value, workType.value);
      suggestion.textContent = text ? "Suggested type: " + workTypes[proposed.type] +
        " · Text estimate: " + formatEffort(effortBands[proposed.band]) : "";
      useType.hidden = !text || proposed.type === workType.value;
    }
    title.oninput = description.oninput = workType.onchange = updateSuggestion;
    updateSuggestion();
    const suggestions = el("div", null, "actions");
    suggestions.append(suggestion, useType);
    form.append(field("Title", "title", title), field("Description", "description", description, false),
      field("Assignee", "assignee", assignee, false), field("Type", "work_type", workType),
      field("Priority", "priority", priority), field("Effort estimate", "effort_band", effort), suggestions);
  }
  else {
    form.append(field("Title", "title", textInput("Describe the code change")),
      field("Repository ID", "repository", textInput("e.g. exports/api")),
      field("External change ID", "external_id", textInput("e.g. PR-48")));
  }
  const errorBox = el("div", null, "dialog-error");
  errorBox.setAttribute("role", "alert");
  const actions = el("div", null, "form-actions");
  const submit = el("button", action, "btn primary");
  submit.type = "submit";
  actions.append(button("Cancel", "btn", () => $("#dialog").close()), submit);
  form.append(errorBox, actions);
  const baseline = Object.fromEntries(new FormData(form));
  const captureToken = type === "work" ? draft?.token || crypto.randomUUID() : null;
  function reviewConflicts(conflicts) {
    for (const [name, current] of Object.entries(conflicts)) {
      const input = form.elements.namedItem(name);
      if (!input) continue;
      const notice = el("div", null, "field-conflict");
      const label = input.labels?.[0]?.textContent || name;
      notice.append(el("strong", label + " changed"), el("p", current || "(empty)", "current-field"));
      const resolve = useCurrent => {
        if (useCurrent) input.value = current;
        baseline[name] = current;
        notice.remove();
        if (!errorBox.querySelector(".field-conflict")) errorBox.textContent = "";
        input.focus();
      };
      notice.append(button("Use current value", "btn", () => resolve(true)),
        button("Keep my edit", "btn", () => resolve(false)));
      errorBox.append(notice);
    }
  }
  form.onsubmit = event => {
    event.preventDefault();
    if (submit.disabled || errorBox.querySelector(".field-conflict")) return;
    let body = Object.fromEntries(new FormData(form));
    if (type === "edit") {
      body = Object.fromEntries(Object.entries(body).filter(([name, value]) => value !== baseline[name]));
      if (!Object.keys(body).length) {
        $("#dialog").close();
        load(state.workspace).catch(error => message(error.message, true));
        return;
      }
      body.expected = Object.fromEntries(Object.keys(body).map(name => [name, baseline[name]]));
    }
    if (captureToken) body.capture_token = captureToken;
    save(submit, path, method, body, success, errorBox, reviewConflicts, () => {
      if (draft && draft.token === captureToken) {
        draft.title = "";
        draft.token = crypto.randomUUID();
        if (captureDrafts.get(state.workspace) === draft && $(".quick-capture input")) $(".quick-capture input").value = "";
      }
    });
  };
  content.append(form);
  form.querySelector("input,select")?.focus();
}

function openGlobalSearch() {
  if ($("#dialog").open) return;
  const previousFocus = document.activeElement;
  const content = showDialog("Search requirements");
  const input = textInput("Search by title or key, e.g. WT-012");
  input.type = "search";
  input.maxLength = 160;
  input.className = "global-query";
  input.setAttribute("aria-label", "Requirement title or key");
  const feedback = el("p", "", "search-feedback");
  feedback.setAttribute("role", "status");
  const list = el("ul", null, "global-results");
  let revision = 0;
  let timer;
  function onQuery() {
    const version = ++revision;
    clearTimeout(timer);
    list.replaceChildren();
    const q = input.value.trim();
    if (!q) {
      feedback.textContent = settings.actor ? "Search your workspace, example project, and active projects." : "Searching the example project. Sign in to search other projects.";
      return;
    }
    feedback.textContent = "Searching…";
    timer = setTimeout(async () => {
      try {
        const results = await request("local", "/search?q=" + encodeURIComponent(q));
        if (version !== revision || !input.isConnected) return;
        feedback.textContent = results.more ? "Showing the first 40 matches. Refine your search for more." : results.items.length
          ? results.items.length + (results.items.length === 1 ? " match" : " matches") : "No matching requirements.";
        for (const item of results.items) {
          const result = el("a", null, "global-result");
          result.href = "/?" + new URLSearchParams({workspace: item.workspace, item: item.id}) + "#board";
          const title = el("span", null, "result-title");
          title.append(el("span", key(item), "key"), el("strong", item.title));
          const details = el("small", null, "result-meta");
          details.append(el("b", item.project), document.createTextNode(" · " + lanes[item.status] + " · " + (item.owner || "Unassigned")));
          if (item.blockers) {
            const extra = item.blockers > 1 ? " +" + (item.blockers - 1) : "";
            details.append(el("span", "Blocked by " + key({number: item.blocker_number}) + " · " + item.blocker_title + extra, "result-blocker"));
          } else details.append(document.createTextNode(" · No blockers"));
          result.append(title, details);
          const li = el("li");
          li.append(result);
          list.append(li);
        }
      } catch (error) {
        if (version === revision && input.isConnected) feedback.textContent = "Search failed. " + error.message;
      }
    }, 140);
  }
  input.oninput = onQuery;
  content.onkeydown = event => {
    if (event.isComposing) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      $("#dialog").close();
      return;
    }
    const links = [...list.querySelectorAll("a")];
    if (!links.length) return;
    const i = links.indexOf(document.activeElement);
    if (event.key === "Enter" && event.target === input) {
      event.preventDefault();
      links[0].click();
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (event.key === "ArrowUp" && i === 0) input.focus();
      else links[event.key === "ArrowDown" ? Math.min(i + 1, links.length - 1) : i < 0 ? links.length - 1 : i - 1].focus();
    }
  };
  $("#dialog").addEventListener("close", () => {
    clearTimeout(timer);
    revision++;
    if (!$("#dialog").open) {
      const target = previousFocus?.isConnected && previousFocus !== document.body ? previousFocus : $("#global-search");
      target.focus({preventScroll: true});
    }
  }, {once: true});
  content.append(input, feedback, list);
  onQuery();
  input.focus();
}

$("#global-search").onclick = openGlobalSearch;
$("#search-shortcut").textContent = /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘ K" : "Ctrl K";
document.addEventListener("keydown", event => {
  if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "k" && !$("#dialog").open) {
    event.preventDefault();
    openGlobalSearch();
  }
});

for (const placeholder of document.querySelectorAll("[data-icon]")) placeholder.append(icon(placeholder.dataset.icon));
drawWeave();
$("#dialog").addEventListener("close", () => {
  const url = new URL(location.href);
  const dialog = $("#dialog");
  if (dialog.dataset.linkedItem && !dialog.open) {
    if (url.searchParams.get("item") === dialog.dataset.linkedItem) {
      url.searchParams.delete("item");
      history.replaceState(null, "", url);
    }
    delete dialog.dataset.linkedItem;
  }
});
$("#dialog").addEventListener("click", event => { if (event.target === $("#dialog")) $("#dialog").close(); });
async function selectWorkspace(selected) {
  try {
    await load(selected);
    if (state.workspace !== selected) return false;
    const url = new URL(location.href);
    url.searchParams.delete("workspace");
    url.searchParams.delete("item");
    history.replaceState(null, "", url);
    try { localStorage.setItem("wefttrack.workspace", selected); } catch { /* Storage may be disabled. */ }
    return true;
  } catch (error) {
    message(error.message, true);
    return false;
  }
}

$("#workspace").addEventListener("change", event => selectWorkspace(event.target.value));
window.addEventListener("hashchange", () => { $("#dialog").close(); render(); });
async function startWorkspace() {
  await loadSettings();
  try { if (localStorage.getItem("wefttrack.layout") === "list") state.layout = "list"; } catch { /* Optional preference. */ }
  const incoming = new URLSearchParams(location.search);
  const targetWorkspace = incoming.get("workspace");
  if (targetWorkspace) {
    if (!settings.actor && targetWorkspace !== "example") {
      state.workspace = "local";
      $("#workspace").value = "local";
      connection("Sign-in required");
      render();
      return;
    }
    if (!Object.hasOwn(workspaces, targetWorkspace)) {
      throw new Error("The linked workspace is unavailable.");
    }
    const id = incoming.get("item");
    await load(targetWorkspace, id);
    const resolved = graph.change_aliases?.[id] || id;
    if (id && !nodes.has(resolved)) message("The linked item is unavailable in this workspace.", true);
    else if (id && getView() === "board") {
      if (resolved !== id) {
        const url = new URL(location.href);
        url.searchParams.set("item", resolved);
        history.replaceState(null, "", url);
      }
      showDetails(resolved);
    }
    return;
  }
  let storedWorkspace;
  try { storedWorkspace = localStorage.getItem("wefttrack.workspace"); } catch { /* Storage may be disabled. */ }
  const saved = Object.hasOwn(workspaces, storedWorkspace);
  if (!settings.actor && storedWorkspace !== "example") {
    connection("Sign-in required");
    render();
    return;
  }
  await load(saved ? storedWorkspace : "local");
}
startWorkspace().catch(error => message("Unable to load workspace. " + error.message, true));
