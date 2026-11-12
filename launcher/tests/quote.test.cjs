const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const source = fs.readFileSync(
  path.join(__dirname, "..", "quote.js"),
  "utf8"
);
const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date(2026, 10, 11, 9, 30).getTime();
const seconds = date => String(Math.floor(date.getTime() / 1000));

function pair(code, bid, pctChange, at) {
  return { code, codein: "BRL", bid, pctChange, timestamp: seconds(at) };
}

function payload(overrides = {}) {
  return Object.assign({
    USDBRL: pair("USD", "5.5829", "1.348796", new Date(2026, 10, 10, 19, 5)),
    EURBRL: pair("EUR", "6.2331", "-0.032073", new Date(2026, 10, 11, 9, 11)),
    BTCBRL: pair("BTC", "410824.4", "0.001", new Date(2026, 10, 11, 9, 28))
  }, overrides);
}

function ticker(overrides = {}) {
  return Object.assign({
    symbol: "USDTBRL",
    lastPrice: "5.56210000",
    priceChangePercent: "0.619",
    closeTime: new Date(2026, 10, 11, 9, 29).getTime()
  }, overrides);
}

function element(id) {
  const node = { id, hidden: id === "market", textContent: "", className: "", children: [] };
  node.appendChild = child => { node.children.push(child); return child; };
  node.removeChild = child => { node.children.splice(node.children.indexOf(child), 1); return child; };
  Object.defineProperty(node, "firstChild", { get: () => node.children[0] || null });
  return node;
}

// Answers for each API, in request order.
function createQuote(awesome, tether = [ticker()]) {
  const elements = { market: element("market"), "market-list": element("market-list") };
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
      const next = (url.startsWith("https://api.binance.com/") ? tether : awesome).shift();
      if (next instanceof Error) return Promise.reject(next);
      return Promise.resolve({ ok: true, json: () => Promise.resolve(next) });
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
  vm.runInNewContext(source, { window, document, console, Date: FixedDate }, { filename: "quote.js" });
  return { quote: window.LauncherQuote, elements, timers, requests, clock };
}

const settle = () => new Promise(resolve => setImmediate(resolve));
const rows = h => h.elements["market-list"].children.map(row => row.children.map(cell => cell.textContent));

test("lists the dollar, USDT, the euro and bitcoin in reais with change and time", async () => {
  const h = createQuote([payload()]);
  await settle();
  assert.deepEqual(h.requests.map(request => request.url), [
    "https://economia.awesomeapi.com.br/json/last/USD-BRL,EUR-BRL,BTC-BRL",
    "https://api.binance.com/api/v3/ticker/24hr?symbol=USDTBRL"
  ]);
  for (const request of h.requests) {
    assert.equal(request.options.credentials, "omit");
    assert.equal(request.options.cache, "no-cache");
  }
  assert.equal(h.elements.market.hidden, false);
  assert.deepEqual(rows(h), [
    ["Dólar", "R$ 5,58", "+1,35%", "10/11 19:05"],
    ["USDT", "R$ 5,56", "+0,62%", "09:29"],
    ["Euro", "R$ 6,23", "−0,03%", "09:11"],
    ["Bitcoin", "R$ 410.824", "0,00%", "09:28"]
  ]);
  assert.deepEqual(h.elements["market-list"].children[0].children.map(cell => cell.className),
    ["market-name", "market-price", "market-change up", "market-time"]);
  assert.equal(h.elements["market-list"].children[2].children[2].className, "market-change down");
  assert.equal(h.elements["market-list"].children[3].children[2].className, "market-change flat");
});

test("either source can fail without hiding the other", async () => {
  const noTether = createQuote([payload()], [new Error("offline")]);
  await settle();
  assert.deepEqual(rows(noTether).map(row => row[0]), ["Dólar", "Euro", "Bitcoin"]);
  const onlyTether = createQuote([new Error("offline")]);
  await settle();
  assert.deepEqual(rows(onlyTether).map(row => row[0]), ["USDT"]);
});

test("rejects a ticker for another pair or with implausible numbers", () => {
  const { quote } = createQuote([new Error("offline")], [new Error("offline")]);
  assert.equal(quote.parseTether(ticker()).length, 1);
  for (const broken of [
    null,
    ticker({ symbol: "BTCBRL" }),
    ticker({ lastPrice: "abc" }),
    ticker({ lastPrice: "0" }),
    ticker({ lastPrice: "500" }),
    ticker({ priceChangePercent: "80" }),
    ticker({ closeTime: "soon" }),
    ticker({ closeTime: 1.5 })
  ]) {
    assert.equal(quote.parseTether(broken), null);
  }
});

test("leaves out an implausible pair and rejects a payload with none", () => {
  const { quote } = createQuote([new Error("offline")]);
  const at = new Date(2026, 10, 11, 9, 0);
  for (const broken of [
    { USDBRL: pair("EUR", "5.5", "1", at) },
    { USDBRL: pair("USD", "abc", "1", at) },
    { USDBRL: pair("USD", "0", "1", at) },
    { USDBRL: pair("USD", "500", "1", at) },
    { USDBRL: pair("USD", "5.5", "80", at) },
    { USDBRL: Object.assign(pair("USD", "5.5", "1", at), { timestamp: "soon" }) },
    { BTCBRL: pair("BTC", "12", "1", at) }
  ]) {
    const name = Object.keys(broken)[0];
    const parsed = quote.parse(payload(broken));
    assert.equal(parsed.length, 2, name);
    assert.ok(parsed.every(entry => entry.pair.key !== name));
  }
  assert.equal(quote.parse(null), null);
  assert.equal(quote.parse({}), null);
});

test("keeps the last quotes when a refresh fails and drops each one after four days", async () => {
  const h = createQuote([payload(), new Error("offline")], [ticker(), new Error("offline")]);
  await settle();
  await h.quote.refresh();
  assert.equal(rows(h).length, 4);

  const expiry = [...h.timers.values()].find(timer => timer.callback.name === "render");
  assert.equal(expiry.delay, new Date(2026, 10, 10, 19, 5).getTime() + 4 * DAY - NOW);
  h.clock.now = new Date(2026, 10, 10, 19, 5).getTime() + 4 * DAY + 1;
  expiry.callback();
  assert.deepEqual(rows(h).map(row => row[0]), ["USDT", "Euro", "Bitcoin"]);

  const old = new Date(NOW - 5 * DAY);
  const stale = createQuote([payload({
    USDBRL: pair("USD", "5.5", "1", old), EURBRL: pair("EUR", "6.2", "1", old), BTCBRL: pair("BTC", "400000", "1", old)
  })], [ticker({ closeTime: old.getTime() })]);
  await settle();
  assert.equal(stale.elements.market.hidden, true);
});

test("refreshes every ten minutes and stop cancels the timers", async () => {
  const h = createQuote([payload()]);
  await settle();
  const delays = [...h.timers.values()].map(timer => timer.delay);
  assert.ok(delays.includes(10 * 60 * 1000));
  h.quote.stop();
  assert.equal(h.timers.size, 0);
});
