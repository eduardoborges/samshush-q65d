const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const source = fs.readFileSync(
  path.join(__dirname, "..", "layouts", "q65d-2123", "news.js"),
  "utf8"
);
const HOUR = 3600 * 1000;
const NOW = new Date(2026, 10, 11, 9, 30).getTime();
const at = (hours, minutes = 0) => new Date(2026, 10, 11, hours, minutes).toISOString();
const photo = name => `https://s2-g1.glbimg.com/sig=/540x304/smart/https://i.s3.glbimg.com/${name}.jpg`;

let articles = 0;
function item(title, publication, { url = `https://g1.globo.com/noticia/${++articles}.ghtml`, image, section = "Política" } = {}) {
  const content = { title, url, section, type: "materia" };
  if (image !== null) content.image = { sizes: { S: { url: image || photo(`p${articles}`) }, XS: { url: photo("small") } } };
  return { type: "materia", publication, content };
}

const ITEMS = [
  item("Governo articula   ajuste\n nas contas", at(9, 10), { image: null, section: "Economia" }),
  item("Lucro da Petrobras sobe", at(8, 45), { section: "Economia" }),
  item("", at(8, 40)),
  item("Sem data", "ontem"),
  item("Link de fora", at(8, 30), { url: "https://ge.globo.com/futebol.ghtml" }),
  item("Link sem https", at(8, 20), { url: "http://g1.globo.com/noticia.ghtml" }),
  item("Repetida", at(8, 10), { url: "https://g1.globo.com/noticia/2.ghtml" }),
  item("Foto de fora", at(8), { image: "https://example.com/foto.jpg", section: "" }),
  item("Notícia de ontem", new Date(2026, 10, 10, 22, 5).toISOString()),
  item("Quarta", at(7)),
  item("Quinta", at(6)),
  item("Sexta", at(5)),
  item("Sétima que não aparece", at(4))
];
const FEED = { items: ITEMS };

class Node {
  constructor(name, id) {
    this.name = name;
    this.id = id;
    this.children = [];
    this.parentNode = null;
    this.dataset = {};
    this.attributes = {};
    this.style = {};
    this.listeners = {};
    this.hidden = id === "news";
    this.textContent = "";
    this.className = "";
    this.classList = {
      toggle: (name, on) => {
        const names = new Set(this.className.split(" ").filter(Boolean));
        if (on) names.add(name);
        else names.delete(name);
        this.className = [...names].join(" ");
      },
      contains: name => this.className.split(" ").includes(name)
    };
  }
  get firstChild() { return this.children[0] || null; }
  appendChild(child) {
    child.parentNode = this;
    this.children.push(child);
    return child;
  }
  removeChild(child) {
    this.children.splice(this.children.indexOf(child), 1);
    child.parentNode = null;
    return child;
  }
  contains(node) {
    for (let at = node; at; at = at.parentNode) if (at === this) return true;
    return false;
  }
  setAttribute(key, value) { this.attributes[key] = String(value); }
  addEventListener(type, handler) { this.listeners[type] = handler; }
}

function createNews(responses) {
  const elements = {};
  for (const id of ["news", "news-dots", "news-slide", "news-track", "news-next"]) elements[id] = new Node("element", id);
  elements.news.appendChild(elements["news-dots"]);
  elements.news.appendChild(elements["news-slide"]).appendChild(elements["news-track"]);
  elements.news.appendChild(elements["news-next"]);
  const timers = new Map();
  let timerID = 0;
  const requests = [];
  const document = {
    hidden: false,
    activeElement: null,
    getElementById(id) { return elements[id] || null; },
    createElement(name) { return new Node(name); },
    addEventListener() {},
    removeEventListener() {}
  };
  const ui = {
    refreshes: 0,
    controls: {},
    refresh() { this.refreshes += 1; },
    setControl(id, handler) { this.controls[id] = handler; }
  };
  const window = {
    LauncherUI: ui,
    fetch(url, options) {
      requests.push({ url, options });
      const next = responses.shift();
      if (next instanceof Error) return Promise.reject(next);
      const body = typeof next === "string" ? next : JSON.stringify(next);
      return Promise.resolve({ ok: true, text: () => Promise.resolve(body) });
    },
    AbortController: function () { this.signal = {}; this.abort = () => {}; },
    setTimeout(callback, delay) { timers.set(++timerID, { callback, delay }); return timerID; },
    clearTimeout(id) { timers.delete(id); }
  };
  const clock = { now: NOW };
  const RealDate = Date;
  class FixedDate extends RealDate {
    constructor(...args) { super(...(args.length ? args : [clock.now])); }
    static now() { return clock.now; }
  }
  vm.runInNewContext(source, { window, document, console, URL, JSON, Date: FixedDate }, { filename: "news.js" });
  const slides = () => elements["news-track"].children.map(slide => {
    const words = slide.children[slide.children.length - 1];
    const image = slide.children.length > 1 ? slide.children[0].src : null;
    return [image, ...words.children.map(cell => cell.textContent)];
  });
  const timer = name => [...timers.values()].find(entry => entry.callback.name === name);
  const position = () => elements["news-dots"].children.findIndex(dot => dot.className === "current");
  return { news: window.LauncherNews, elements, timers, requests, clock, ui, document, slides, timer, position };
}

const settle = () => new Promise(resolve => setImmediate(resolve));

test("shows six headlines from the g1 home feed as slides with their photos", async () => {
  const h = createNews([FEED]);
  await settle();
  assert.equal(h.requests[0].url,
    "https://falkor-cda.bastian.globo.com/tenants/g1/instances/4af56893-1f9a-4504-9531-74458e481f91/posts/page/1");
  assert.equal(h.requests[0].options.credentials, "omit");
  assert.equal(h.requests[0].options.referrerPolicy, "no-referrer");
  assert.equal(h.elements.news.hidden, false);
  assert.equal(h.ui.refreshes, 1);
  assert.deepEqual(h.slides(), [
    [null, "Economia · 09:10", "Governo articula ajuste nas contas"],
    [photo("p2"), "Economia · 08:45", "Lucro da Petrobras sobe"],
    [null, "08:00", "Foto de fora"],
    [photo("p6"), "Política · 10/11", "Notícia de ontem"],
    [photo("p7"), "Política · 07:00", "Quarta"],
    [photo("p8"), "Política · 06:00", "Quinta"]
  ]);
  const image = h.elements["news-track"].children[1].children[0];
  assert.equal(image.className, "news-image");
  assert.equal(image.alt, "");
  assert.equal(h.elements["news-slide"].dataset.url, "https://g1.globo.com/noticia/1.ghtml");
  assert.equal(h.elements["news-slide"].attributes["aria-label"], "Governo articula ajuste nas contas");
  assert.equal(h.elements["news-dots"].children.length, 6);
  assert.equal(h.position(), 0);
  assert.equal(h.elements["news-track"].style.transform, "translateX(0%)");
});

test("advances every 8 seconds, waits while the focus is on the block and jumps back after the last slide", async () => {
  const h = createNews([FEED]);
  await settle();
  const track = h.elements["news-track"];
  assert.equal(h.timer("advance").delay, 8000);
  h.timer("advance").callback();
  assert.equal(h.position(), 1);
  assert.equal(track.style.transform, "translateX(-100%)");
  assert.equal(track.className, "");
  assert.equal(h.elements["news-slide"].dataset.url, "https://g1.globo.com/noticia/2.ghtml");

  h.document.activeElement = h.elements["news-next"];
  h.timer("advance").callback();
  assert.equal(h.position(), 1);
  h.document.activeElement = null;

  for (let step = 2; step <= 5; step += 1) h.timer("advance").callback();
  assert.equal(h.position(), 5);
  h.timer("advance").callback();
  assert.equal(h.position(), 0);
  assert.equal(track.className, "news-jump");
  assert.equal(track.style.transform, "translateX(0%)");
});

test("the previous and next buttons step through the slides and restart the wait", async () => {
  const h = createNews([FEED]);
  await settle();
  const first = h.timer("advance");
  h.ui.controls["news-previous"]();
  assert.equal(h.position(), 5);
  assert.equal(h.elements["news-track"].className, "news-jump");
  h.ui.controls["news-next"]();
  h.ui.controls["news-next"]();
  assert.equal(h.position(), 1);
  assert.equal(h.elements["news-track"].className, "");
  assert.notEqual(h.timer("advance"), first);
  assert.equal([...h.timers.values()].filter(entry => entry.callback.name === "advance").length, 1);
});

test("rebuilds the slides only when the headlines change and keeps the one on screen", async () => {
  const moved = { items: [item("Nova manchete", at(9, 20)), ...ITEMS] };
  const h = createNews([FEED, FEED, moved]);
  await settle();
  h.ui.controls["news-next"]();
  const first = h.elements["news-track"].children[0];
  await h.news.refresh();
  assert.equal(h.elements["news-track"].children[0], first);
  await h.news.refresh();
  assert.equal(h.slides()[0][2], "Nova manchete");
  assert.equal(h.position(), 2);
  assert.equal(h.elements["news-slide"].dataset.url, "https://g1.globo.com/noticia/2.ghtml");
  assert.equal(h.elements["news-track"].className, "news-jump");
  assert.equal(h.ui.refreshes, 1);
});

test("a photo that fails to load leaves the headline text", async () => {
  const h = createNews([FEED]);
  await settle();
  const slide = h.elements["news-track"].children[1];
  slide.children[0].listeners.error();
  assert.deepEqual(slide.children.map(child => child.className), ["news-text"]);
});

test("rejects anything that is not a feed with headlines", async () => {
  const { news } = createNews([new Error("offline")]);
  for (const value of [
    null,
    {},
    { items: "x" },
    { items: [] },
    { items: [null, item("Sem link", at(9), { url: 42 }), item("Fora", at(9), { url: "https://example.com/" })] }
  ]) {
    assert.equal(news.parse(value), null);
  }
  const huge = createNews([JSON.stringify(FEED) + " ".repeat(2 * 1024 * 1024)]);
  await settle();
  assert.equal(huge.elements.news.hidden, true);
  const broken = createNews(["<html>Not found</html>"]);
  await settle();
  assert.equal(broken.elements.news.hidden, true);
});

test("keeps the last headlines after a failed refresh and hides them after six hours", async () => {
  const h = createNews([FEED, new Error("offline")]);
  await settle();
  h.clock.now = NOW + 30 * 60 * 1000;
  await h.news.refresh();
  assert.equal(h.requests.length, 2);
  assert.equal(h.slides().length, 6);
  const expiry = h.timer("render");
  assert.equal(expiry.delay, 6 * HOUR - 30 * 60 * 1000);
  h.clock.now = NOW + 6 * HOUR + 1;
  expiry.callback();
  assert.equal(h.elements.news.hidden, true);
  assert.equal(h.slides().length, 0);
  assert.equal(h.ui.refreshes, 2);
  assert.equal(h.timer("advance"), undefined);
});

test("refreshes every half hour and stop cancels every timer", async () => {
  const h = createNews([FEED]);
  await settle();
  assert.ok([...h.timers.values()].some(entry => entry.delay === 30 * 60 * 1000));
  h.news.stop();
  assert.equal(h.timers.size, 0);
});
