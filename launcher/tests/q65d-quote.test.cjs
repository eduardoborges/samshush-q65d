const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const source = fs.readFileSync(
  path.join(__dirname, "..", "layouts", "q65d-2123", "quote.js"),
  "utf8"
);
const NOW = new Date(2026, 10, 11, 9, 30).getTime();

function payload(overrides = {}) {
  return {
    USDBRL: Object.assign({
      code: "USD",
      codein: "BRL",
      bid: "5.5829",
      pctChange: "1.348796",
      timestamp: String(Math.floor(new Date(2026, 10, 11, 9, 5).getTime() / 1000))
    }, overrides)
  };
}

function createQuote(responses) {
  const elements = {};
  for (const id of ["quote", "quote-price", "quote-change", "quote-time"]) {
    elements[id] = { id, hidden: id === "quote", textContent: "", className: "" };
  }
  const timers = new Map();
  let timerID = 0;
  const requests = [];
  const document = {
    hidden: false,
    getElementById(id) { return elements[id] || null; },
    addEventListener() {},
    removeEventListener() {}
  };
  const window = {
    fetch(url, options) {
      requests.push({ url, options });
      const next = responses.shift();
      if (next instanceof Error) return Promise.reject(next);
      return Promise.resolve({ ok: true, json: () => Promise.resolve(next) });
    },
    AbortController: function () { this.signal = {}; this.abort = () => {}; },
    setTimeout(callback, delay) { timers.set(++timerID, { callback, delay }); return timerID; },
    clearTimeout(id) { timers.delete(id); }
  };
  const RealDate = Date;
  class FixedDate extends RealDate {
    constructor(...args) { super(...(args.length ? args : [NOW])); }
    static now() { return NOW; }
  }
  vm.runInNewContext(source, { window, document, console, Date: FixedDate, Number, Math, String, Promise },
    { filename: "quote.js" });
  return { quote: window.LauncherQuote, elements, timers, requests };
}

const settle = () => new Promise(resolve => setImmediate(resolve));

test("shows the dollar in reais with the change and time of the quote", async () => {
  const h = createQuote([payload()]);
  await settle();
  assert.equal(h.requests[0].url, "https://economia.awesomeapi.com.br/json/last/USD-BRL");
  assert.equal(h.requests[0].options.credentials, "omit");
  assert.equal(h.elements.quote.hidden, false);
  assert.equal(h.elements["quote-price"].textContent, "R$ 5,58");
  assert.equal(h.elements["quote-change"].textContent, "+1,35%");
  assert.equal(h.elements["quote-change"].className, "quote-change up");
  assert.equal(h.elements["quote-time"].textContent, "às 09:05");
});

test("formats falls, flat days and quotes from an earlier day", () => {
  const { quote } = createQuote([new Error("offline")]);
  const friday = new Date(2026, 10, 6, 17, 59).getTime();
  assert.deepEqual(
    JSON.parse(JSON.stringify(quote.format({ bid: 5.4, change: -0.256, time: friday }, NOW))),
    { price: "R$ 5,40", change: "−0,26%", direction: "down", time: "06/11 17:59" }
  );
  assert.equal(quote.format({ bid: 5.4, change: 0.001, time: NOW }, NOW).direction, "flat");
  assert.equal(quote.format({ bid: 5.4, change: 0.001, time: NOW }, NOW).change, "0,00%");
});

test("rejects data that is not a plausible USD-BRL quote", () => {
  const { quote } = createQuote([new Error("offline")]);
  for (const value of [
    null,
    {},
    payload({ code: "EUR" }),
    payload({ bid: "abc" }),
    payload({ bid: "0" }),
    payload({ bid: "500" }),
    payload({ pctChange: "80" }),
    payload({ timestamp: "soon" })
  ]) {
    assert.equal(quote.parse(value), null);
  }
  assert.equal(quote.parse(payload()).bid, 5.5829);
});

test("keeps the last quote when a refresh fails and hides a quote older than four days", async () => {
  const h = createQuote([payload(), new Error("offline")]);
  await settle();
  await h.quote.refresh();
  assert.equal(h.elements.quote.hidden, false);
  assert.equal(h.elements["quote-price"].textContent, "R$ 5,58");

  const old = String(Math.floor((NOW - 5 * 24 * 60 * 60 * 1000) / 1000));
  const stale = createQuote([payload({ timestamp: old })]);
  await settle();
  assert.equal(stale.elements.quote.hidden, true);
});

test("refreshes every ten minutes and stop cancels the timers", async () => {
  const h = createQuote([payload()]);
  await settle();
  const delays = [...h.timers.values()].map(timer => timer.delay);
  assert.ok(delays.includes(10 * 60 * 1000));
  h.quote.stop();
  assert.equal(h.timers.size, 0);
});
