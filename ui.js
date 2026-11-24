"use strict";

const board = document.querySelector("#board");
const notice = document.querySelector("#notice");
const linkForm = document.querySelector("#link");
const lanes = { open: "Open", active: "Active", review: "Review", done: "Done" };
const linkLabels = { blocks: "blocks", parent_of: "is parent of", implements: "implements" };
let graph = { nodes: [], edges: [], transitions: {} };

function element(tag, value, className) {
  const node = document.createElement(tag);
  if (value !== undefined) node.textContent = value;
  if (className) node.className = className;
  return node;
}

async function request(path, method = "GET", body) {
  const response = await fetch(path, {
    method,
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Request failed");
  return data;
}

function report(message, isError = false) {
  notice.textContent = message;
  notice.toggleAttribute("data-error", isError);
}

async function mutate(control, path, method, body, message, reset) {
  control.disabled = true;
  try {
    await request(path, method, body);
    if (reset) reset.reset();
    report(message);
    try {
      await load();
    } catch {
      report(message + " Refresh the page to reload the board.", true);
    }
  } catch (error) {
    report(error.message, true);
    if (control.tagName === "SELECT") control.value = "";
  } finally {
    control.disabled = false;
  }
}

function card(item) {
  const article = element("article", undefined, "card");
  const select = element("select");
  select.setAttribute("aria-label", "Move " + item.title);
  select.append(new Option("Move to…", ""));
  for (const status of graph.transitions[item.status] || []) {
    select.append(new Option(lanes[status], status));
  }
  select.addEventListener("change", () => {
    if (select.value) {
      mutate(select, "/work/" + item.id, "PATCH", { status: select.value }, "Work item moved.");
    }
  });
  article.append(element("p", item.title), select);
  return article;
}

function nodeLabel(node) {
  if (node.kind === "change") return node.title + " (" + node.repository + " / " + node.external_id + ")";
  return node.title + " (" + node.id.slice(0, 8) + ")";
}

function setOptions(select, entries, placeholder) {
  const previous = select.value;
  select.replaceChildren(new Option(placeholder, ""));
  for (const node of entries) select.append(new Option(nodeLabel(node), node.id));
  if (entries.some(node => node.id === previous)) select.value = previous;
}

function updateLinkOptions() {
  const work = graph.nodes.filter(node => node.kind === "work");
  const sourceKind = linkForm.elements.kind.value === "implements" ? "change" : "work";
  setOptions(linkForm.elements.source, graph.nodes.filter(node => node.kind === sourceKind), "Select a source");
  setOptions(linkForm.elements.target, work.filter(node => node.id !== linkForm.elements.source.value), "Select a work item");
}

async function load() {
  graph = await request("/graph");
  board.replaceChildren();
  for (const [status, title] of Object.entries(lanes)) {
    const lane = element("section", undefined, "lane");
    const items = graph.nodes.filter(node => node.kind === "work" && node.status === status);
    const heading = element("h3");
    heading.append(element("span", title), element("span", items.length));
    lane.append(heading);
    if (!items.length) lane.append(element("p", "No work items", "muted"));
    for (const item of items) lane.append(card(item));
    board.append(lane);
  }

  const nodes = new Map(graph.nodes.map(node => [node.id, node]));
  const relationships = document.querySelector("#relationships");
  relationships.replaceChildren();
  if (!graph.edges.length) relationships.append(element("p", "No relationships yet.", "muted"));
  for (const edge of graph.edges) {
    const row = element("div", undefined, "relationship");
    row.append(element("span", nodeLabel(nodes.get(edge.source))),
      element("strong", linkLabels[edge.kind]),
      element("span", nodeLabel(nodes.get(edge.target))));
    relationships.append(row);
  }
  const changes = document.querySelector("#changes");
  changes.replaceChildren();
  for (const node of graph.nodes.filter(node => node.kind === "change")) {
    changes.append(element("li", nodeLabel(node)));
  }
  updateLinkOptions();
}

function bind(form, path, method, message) {
  form.addEventListener("submit", event => {
    event.preventDefault();
    const body = Object.fromEntries(new FormData(form));
    mutate(event.submitter || form.querySelector("button"), path, method, body, message, form);
  });
}

linkForm.elements.kind.addEventListener("change", updateLinkOptions);
linkForm.elements.source.addEventListener("change", updateLinkOptions);
bind(document.querySelector("#create"), "/work", "POST", "Work item added.");
bind(document.querySelector("#change"), "/changes", "PUT", "Code change saved.");
bind(linkForm, "/links", "POST", "Relationship added.");
load().catch(error => report(error.message, true));
