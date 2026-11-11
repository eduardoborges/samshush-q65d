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

// The page's rows: the headline and its buttons in the header, hidden until the feed loads, then
// the shelves.
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
  const slider = new Node(document, ["tiles"]).append(
    tile(document, "news", "Manchete", "https://g1.globo.com/1.ghtml"));
  const controls = new Node(document, ["tiles"]).append(
    tile(document, "news-previous", "Notícia anterior"), tile(document, "news-next", "Próxima notícia"));
  controls.dataset.start = "1";
  news.append(slider, controls);
  const apps = new Node(document, ["tiles"]).append(
    tile(document, "youtube", "YouTube"), tile(document, "stremio", "Stremio"), tile(document, "spotify", "Spotify"));
  const inputs = new Node(document, ["tiles"]).append(tile(document, "tv", "TV ao vivo"));
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
  vm.runInNewContext(source, { window, document, console, Promise, Map, WeakMap, Date }, { filename: "ui.js" });
  const key = name => listeners.keydown({ key: name, preventDefault() {} });
  const selected = () => body.descendants().filter(node => node.classes.has("selected")).map(node => node.dataset.id);
  const show = () => {
    news.hidden = false;
    window.LauncherUI.refresh();
  };
  return { ui: window.LauncherUI, document, news, ids, actions, key, selected, show };
}

const settle = () => new Promise(resolve => setImmediate(resolve));
const plain = value => JSON.parse(JSON.stringify(value));

test("starts on YouTube and leaves the hidden headline row out of navigation", () => {
  const h = createUI();
  assert.deepEqual(h.selected(), ["youtube"]);
  assert.equal(h.document.activeElement.dataset.id, "youtube");
  assert.equal(h.ids["selection-title"].textContent, "YouTube");
  h.key("ArrowUp");
  assert.deepEqual(h.selected(), ["youtube"]);
  h.ui.refresh();
  h.key("ArrowUp");
  assert.deepEqual(h.selected(), ["youtube"]);
});

test("shown headline rows keep the selection and start on the next button under the headline", async () => {
  const h = createUI();
  h.key("ArrowRight");
  h.show();
  assert.deepEqual(h.selected(), ["stremio"]);
  assert.equal(h.document.activeElement.dataset.id, "stremio");

  h.key("ArrowUp");
  assert.deepEqual(h.selected(), ["news-next"]);
  h.key("ArrowUp");
  assert.deepEqual(h.selected(), ["news"]);
  assert.equal(h.ids["selection-title"].textContent, "Manchete");
  h.key("Enter");
  await settle();
  assert.deepEqual(plain(h.actions), [{ id: "news", type: "link", url: "https://g1.globo.com/1.ghtml" }]);

  h.key("ArrowDown");
  h.key("ArrowLeft");
  assert.deepEqual(h.selected(), ["news-previous"]);
  h.key("ArrowDown");
  assert.deepEqual(h.selected(), ["stremio"]);
  h.key("ArrowUp");
  assert.deepEqual(h.selected(), ["news-previous"]);
});

test("the headline buttons run their module's handler instead of a TV action", async () => {
  const h = createUI();
  const pressed = [];
  h.ui.setControl("news-previous", () => pressed.push("previous"));
  h.ui.setControl("news-next", () => pressed.push("next"));
  h.show();
  h.key("ArrowUp");
  h.key("Enter");
  h.key("ArrowLeft");
  h.key("Enter");
  await settle();
  assert.deepEqual(pressed, ["next", "previous"]);
  assert.deepEqual(h.actions, []);
  assert.deepEqual(h.selected(), ["news-previous"]);
});

test("hiding the headline row while it has the focus returns to YouTube", () => {
  const h = createUI();
  h.show();
  h.key("ArrowUp");
  h.key("ArrowUp");
  assert.deepEqual(h.selected(), ["news"]);
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
  assert.deepEqual(plain(h.actions), [{ id: "tv", type: "source" }]);
  assert.deepEqual(plain(h.ui.getSelection()), { id: "tv", type: "source" });
});
