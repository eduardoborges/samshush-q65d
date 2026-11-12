const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const layout = path.join(__dirname, "..", "layouts", "q65d-2123");
const source = fs.readFileSync(path.join(layout, "ui.js"), "utf8");
const page = fs.readFileSync(path.join(layout, "index.html"), "utf8");

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
      if (selector === ".tile" && node.classes.has("tile")) return node;
    }
    return null;
  }
  getAttribute(name) { return this.attributes[name] ?? null; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  removeAttribute(name) { delete this.attributes[name]; }
  focus() { this.document.activeElement = this; }
}

function tile(document, id, label) {
  const node = new Node(document, ["tile"], { "aria-label": label });
  node.dataset.id = id;
  return node;
}

function createUI(shelf = ["youtube", "stremio", "spotify"]) {
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
  const names = { youtube: "YouTube", stremio: "Stremio", spotify: "Spotify" };
  const apps = new Node(document, ["tiles"]).append(...shelf.map(id => tile(document, id, names[id] || id)));
  const inputs = new Node(document, ["tiles"]).append(tile(document, "tv", "TV ao vivo"));
  body.append(apps, inputs);
  document.body = body;
  document.getElementById = id => ids[id] || null;
  document.querySelectorAll = selector => body.querySelectorAll(selector);
  const actions = [];
  const timers = new Map();
  let timerID = 0;
  const window = {
    LauncherDevice: {
      available: true,
      activate(action) { actions.push(action); return Promise.resolve(); },
      back() { return Promise.resolve(); }
    },
    setInterval() {},
    setTimeout(callback, delay) { timers.set(++timerID, { callback, delay }); return timerID; },
    clearTimeout(id) { timers.delete(id); }
  };
  vm.runInNewContext(source, { window, document, console, Promise, Map, WeakMap, Date }, { filename: "ui.js" });
  const key = name => listeners.keydown({ key: name, preventDefault() {} });
  const selected = () => body.descendants().filter(node => node.classes.has("selected")).map(node => node.dataset.id);
  const restTimers = () => [...timers.values()].filter(timer => timer.callback.name === "rest");
  return { ui: window.LauncherUI, document, body, ids, actions, listeners, key, selected, restTimers };
}

const settle = () => new Promise(resolve => setImmediate(resolve));
const plain = value => JSON.parse(JSON.stringify(value));

test("starts on YouTube", () => {
  const h = createUI();
  assert.deepEqual(h.selected(), ["youtube"]);
  assert.equal(h.document.activeElement.dataset.id, "youtube");
  assert.equal(h.ids["selection-title"].textContent, "YouTube");
  h.key("ArrowUp");
  assert.deepEqual(h.selected(), ["youtube"]);
});

test("app tiles still map to their fixed actions", async () => {
  const h = createUI();
  h.key("ArrowDown");
  h.key("Enter");
  await settle();
  assert.deepEqual(plain(h.actions), [{ id: "tv", type: "source" }]);
  assert.deepEqual(plain(h.ui.getSelection()), { id: "tv", type: "source" });
});

test("every app and input tile in the page has an action", () => {
  const ids = [...page.matchAll(/class="tile[^"]*" data-id="([^"]+)"/g)].map(match => match[1]);
  assert.ok(ids.includes("primevideo") && ids.includes("hdmi-1"));
  const h = createUI(ids);
  for (const id of ids) {
    assert.ok(h.ui.select(id), id);
    const action = h.ui.getSelection();
    assert.equal(action.id, id);
    assert.equal(typeof action.type, "string", id);
  }
});

test("after ten minutes without a key the backdrop rests, and the next key only wakes it", async () => {
  const h = createUI();
  assert.deepEqual(h.restTimers().map(timer => timer.delay), [10 * 60 * 1000]);
  h.key("ArrowRight");
  assert.deepEqual(h.selected(), ["stremio"]);
  assert.equal(h.restTimers().length, 1);

  h.restTimers()[0].callback();
  assert.ok(h.body.classes.has("resting"));
  h.key("Enter");
  await settle();
  assert.ok(!h.body.classes.has("resting"));
  assert.deepEqual(h.actions, []);
  assert.deepEqual(h.selected(), ["stremio"]);
  h.key("ArrowRight");
  assert.deepEqual(h.selected(), ["spotify"]);
  assert.equal(h.restTimers().length, 1);
});

test("an app in front stops the countdown and coming back restarts it awake", () => {
  const h = createUI();
  h.restTimers()[0].callback();
  h.document.hidden = true;
  h.listeners.visibilitychange();
  assert.equal(h.restTimers().length, 0);
  h.document.hidden = false;
  h.listeners.visibilitychange();
  assert.ok(!h.body.classes.has("resting"));
  assert.equal(h.restTimers().length, 1);
});
