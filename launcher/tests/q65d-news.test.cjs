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

function item(title, date) {
  return `<item><title>${title}</title><link>https://g1.globo.com/x</link>` +
    (date ? `<pubDate>${date.toUTCString()}</pubDate>` : "") + "</item>";
}

function feed(items) {
  return `<?xml version='1.0' encoding='UTF-8'?><rss version="2.0"><channel><title>g1</title>${items.join("")}</channel></rss>`;
}

const at = (hours, minutes = 0) => new Date(2026, 10, 11, hours, minutes);
const FEED = feed([
  item("Previsão do tempo hoje para Brasília (DF): sol com algumas nuvens", at(9, 16)),
  item("<![CDATA[Câmara aprova projeto & Senado analisa]]>", at(9, 10)),
  item("Preço do café sobe 3%; veja &quot;o que muda&quot; &amp; por quê", at(8, 45)),
  item("   Bebê   é encontrado &#233; resgatado &#x2014; diz polícia  ", at(8)),
  item("Sem data", null),
  item("", at(7)),
  item("Notícia de ontem", new Date(2026, 10, 10, 22, 5)),
  item("Quinta manchete que não aparece", at(6))
]);

function element(id) {
  const node = { id, hidden: id === "news", textContent: "", className: "", children: [] };
  node.appendChild = child => { node.children.push(child); return child; };
  node.removeChild = child => { node.children.splice(node.children.indexOf(child), 1); return child; };
  Object.defineProperty(node, "firstChild", { get: () => node.children[0] || null });
  return node;
}

function createNews(responses) {
  const elements = { news: element("news"), "news-list": element("news-list") };
  const timers = new Map();
  let timerID = 0;
  const requests = [];
  const document = {
    hidden: false,
    getElementById(id) { return elements[id] || null; },
    createElement(name) { return Object.assign(element(name), { name }); },
    addEventListener() {},
    removeEventListener() {}
  };
  const window = {
    fetch(url, options) {
      requests.push({ url, options });
      const next = responses.shift();
      if (next instanceof Error) return Promise.reject(next);
      return Promise.resolve({ ok: true, text: () => Promise.resolve(next) });
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
  vm.runInNewContext(source, { window, document, console, Date: FixedDate }, { filename: "news.js" });
  return { news: window.LauncherNews, elements, timers, requests, clock };
}

const settle = () => new Promise(resolve => setImmediate(resolve));
const rows = h => h.elements["news-list"].children.map(row => row.children.map(cell => cell.textContent));

test("shows the four latest real headlines with their time, as plain text", async () => {
  const h = createNews([FEED]);
  await settle();
  assert.equal(h.requests[0].url, "https://g1.globo.com/rss/g1/");
  assert.equal(h.requests[0].options.credentials, "omit");
  assert.equal(h.elements.news.hidden, false);
  assert.deepEqual(rows(h), [
    ["09:10", "Câmara aprova projeto & Senado analisa"],
    ["08:45", "Preço do café sobe 3%; veja \"o que muda\" & por quê"],
    ["08:00", "Bebê é encontrado é resgatado — diz polícia"],
    ["10/11", "Notícia de ontem"]
  ]);
  assert.deepEqual(h.elements["news-list"].children[0].children.map(cell => cell.className),
    ["news-time", "news-title"]);
});

test("decodes entities once and keeps markup as text", () => {
  const { news } = createNews([new Error("offline")]);
  const parsed = news.parse(feed([item("&amp;lt;b&amp;gt; &lt;script&gt;x&lt;/script&gt; &#99999999;", at(9))]));
  assert.equal(parsed[0].title, "&lt;b&gt; <script>x</script> &#99999999;");
});

test("rejects anything that is not a feed with headlines", () => {
  const { news } = createNews([new Error("offline")]);
  for (const value of [
    null,
    "",
    "<html>Not found</html>",
    feed([]),
    feed([item("Previsão do tempo hoje para Goiânia (GO): sol", at(9))]),
    feed([item("Sem data", null)]),
    "<rss>" + "x".repeat(2 * 1024 * 1024)
  ]) {
    assert.equal(news.parse(value), null);
  }
});

test("keeps the last headlines after a failed refresh and hides them after six hours", async () => {
  const h = createNews([FEED, new Error("offline")]);
  await settle();
  h.clock.now = NOW + 30 * 60 * 1000;
  await h.news.refresh();
  assert.equal(h.requests.length, 2);
  assert.equal(rows(h).length, 4);
  const expiry = [...h.timers.values()].find(timer => timer.callback.name === "render");
  assert.equal(expiry.delay, 6 * HOUR - 30 * 60 * 1000);
  h.clock.now = NOW + 6 * HOUR + 1;
  expiry.callback();
  assert.equal(h.elements.news.hidden, true);
  assert.equal(rows(h).length, 0);
});

test("refreshes every half hour and stop cancels the timers", async () => {
  const h = createNews([FEED]);
  await settle();
  assert.ok([...h.timers.values()].some(timer => timer.delay === 30 * 60 * 1000));
  h.news.stop();
  assert.equal(h.timers.size, 0);
});
