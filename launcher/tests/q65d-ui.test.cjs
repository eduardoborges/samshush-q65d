const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const source = fs.readFileSync(
  path.join(__dirname, "..", "layouts", "q65d-2123", "ui.js"),
  "utf8"
);

// Just enough DOM for ui.js: elements with classes, attributes, parents and focus.
class Node {
  constructor(document, classes = [], attributes = {}) {
    this.document = document;
    this.classes = new Set(classes);
    this.attributes = Object.assign({}, attributes);
    this.dataset = {};
    this.children = [];
    this.parentNode = null;
    this.hidden = false;
    this.textContent = "";
    this.tabIndex = -1;
    this.classList = {
      toggle: (name, on) => (on ? this.classes.add(name) : this.classes.delete(name)),
      contains: name => this.classes.has(name),
      add: name => this.classes.add(name),
      remove: name => this.classes.delete(name)
    };
  }
  append(...children) {
    for (const child of children) {
      child.parentNode = this;
      this.children.push(child);
    }
    return this;
  }
  replaceChildren(...children) {
    for (const child of this.children) child.parentNode = null;
    this.children = [];
    return this.append(...children);
  }
  descendants() {
    return this.children.flatMap(child => [child, ...child.descendants()]);
  }
  querySelectorAll(selector) {
    if (selector === ".tiles") return this.descendants().filter(node => node.classes.has("tiles"));
    if (selector === ".tile:not(:disabled)") return this.descendants().filter(node => node.classes.has("tile"));
    throw new Error(`Unsupported selector ${selector}`);
  }
  closest(selector) {
    for (let node = this; node; node = node.parentNode) {
      if (selector === "[hidden]" && node.hidden) return node;
      if (selector === ".tile" && node.classes.has("tile")) return node;
    }
    return null;
  }
  getAttribute(name) { return this.attributes[name] ?? null; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  removeAttribute(name) { delete this.attributes[name]; }
  focus() { this.document.activeElement = this; }
}

function tile(document, id, label, url) {
  const node = new Node(document, ["tile"], { "aria-label": label });
  node.dataset.id = id;
  if (url) node.dataset.url = url;
  return node;
}

function createUI() {
  const listeners = {};
  const document = {
    hidden: false,
    activeElement: null,
    title: "",
    addEventListener(type, handler) { listeners[type] = handler; }
  };
  const body = new Node(document);
  const ids = {};
  for (const id of ["selection-title", "action-error", "clock", "date"]) ids[id] = new Node(document);
  const news = new Node(document);
  news.hidden = true;
  const newsRow = new Node(document, ["tiles"]);
  news.append(newsRow);
  const apps = new Node(document, ["tiles"]).append(
    tile(document, "youtube", "YouTube"), tile(document, "stremio", "Stremio"), tile(document, "spotify", "Spotify"));
  const inputs = new Node(document, ["tiles"]).append(tile(document, "tv", "TV ao vivo"));
  // Page order: the news row sits in the header, above the shelves.
  body.append(news, apps, inputs);
  document.getElementById = id => ids[id] || null;
  document.querySelectorAll = selector => body.querySelectorAll(selector);
  const actions = [];
  const window = {
    LauncherDevice: {
      available: true,
      activate(action) { actions.push(action); return Promise.resolve(); },
      back() { return Promise.resolve(); }
    },
    setInterval() {}
  };
  vm.runInNewContext(source, { window, document, console, Promise, WeakMap, Date }, { filename: "ui.js" });
  const key = name => listeners.keydown({ key: name, preventDefault() {} });
  const selected = () => body.descendants().filter(node => node.classes.has("selected")).map(node => node.dataset.id);
  const headlines = count => Array.from({ length: count }, (_, index) =>
    tile(document, `news-${index}`, `Manchete ${index}`, `https://g1.globo.com/${index}.ghtml`));
  return { ui: window.LauncherUI, document, news, newsRow, ids, actions, key, selected, headlines };
}

const settle = () => new Promise(resolve => setImmediate(resolve));

test("starts on YouTube and leaves hidden or empty rows out of navigation", () => {
  const h = createUI();
  assert.deepEqual(h.selected(), ["youtube"]);
  assert.equal(h.document.activeElement.dataset.id, "youtube");
  assert.equal(h.ids["selection-title"].textContent, "YouTube");
  h.key("ArrowUp");
  assert.deepEqual(h.selected(), ["youtube"]);

  // A hidden section stays out even while it still holds tiles.
  h.newsRow.append(...h.headlines(2));
  h.ui.refresh();
  h.key("ArrowUp");
  assert.deepEqual(h.selected(), ["youtube"]);
});

test("headlines added later keep the selection and become a row above the apps", async () => {
  const h = createUI();
  h.key("ArrowRight");
  h.newsRow.append(...h.headlines(4));
  h.news.hidden = false;
  h.ui.refresh();
  assert.deepEqual(h.selected(), ["stremio"]);
  assert.equal(h.document.activeElement.dataset.id, "stremio");

  h.key("ArrowUp");
  h.key("ArrowRight");
  h.key("ArrowRight");
  assert.deepEqual(h.selected(), ["news-2"]);
  assert.equal(h.ids["selection-title"].textContent, "Manchete 2");
  h.key("Enter");
  await settle();
  assert.deepEqual(JSON.parse(JSON.stringify(h.actions)),
    [{ id: "news", type: "link", url: "https://g1.globo.com/2.ghtml" }]);

  h.key("ArrowDown");
  assert.deepEqual(h.selected(), ["stremio"]);
  h.key("ArrowUp");
  assert.deepEqual(h.selected(), ["news-2"]);
});

test("rebuilt headlines keep the focused column, and a vanished row returns to YouTube", () => {
  const h = createUI();
  h.newsRow.append(...h.headlines(4));
  h.news.hidden = false;
  h.ui.refresh();
  h.key("ArrowUp");
  h.key("ArrowRight");
  h.key("ArrowRight");
  h.key("ArrowRight");
  assert.deepEqual(h.selected(), ["news-3"]);

  h.newsRow.replaceChildren(...h.headlines(2));
  h.ui.refresh();
  assert.deepEqual(h.selected(), ["news-1"]);
  assert.equal(h.document.activeElement, h.newsRow.children[1]);

  h.newsRow.replaceChildren();
  h.news.hidden = true;
  h.ui.refresh();
  assert.deepEqual(h.selected(), ["youtube"]);
  assert.equal(h.document.activeElement.dataset.id, "youtube");
});

test("app tiles still map to their fixed actions", async () => {
  const h = createUI();
  h.key("ArrowDown");
  h.key("Enter");
  await settle();
  assert.deepEqual(JSON.parse(JSON.stringify(h.actions)), [{ id: "tv", type: "source" }]);
  assert.deepEqual(JSON.parse(JSON.stringify(h.ui.getSelection())), { id: "tv", type: "source" });
});
