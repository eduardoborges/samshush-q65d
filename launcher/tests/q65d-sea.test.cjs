const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const source = fs.readFileSync(
  path.join(__dirname, "..", "layouts", "q65d-2123", "sea.js"),
  "utf8"
);
const HOUR = 3600 * 1000;
const LAG = 65 * 60 * 1000;
const PERIOD = 12.42 * HOUR;
const MIDNIGHT = new Date(2026, 10, 11, 0, 0).getTime();
const NOW = new Date(2026, 10, 11, 9, 30).getTime();
// A clean semidiurnal tide whose model high is at 04:00, so the shown high is at 05:05.
const MODEL_HIGH = MIDNIGHT + 4 * HOUR;

function series(start = MIDNIGHT - 24 * HOUR, hours = 72, level = time =>
  1.2 * Math.cos(2 * Math.PI * (time - MODEL_HIGH) / PERIOD)) {
  const time = [];
  const levels = [];
  for (let i = 0; i < hours; i += 1) {
    const at = start + i * HOUR;
    time.push(at / 1000);
    levels.push(Math.round(level(at) * 100) / 100);
  }
  return { time, sea_level_height_msl: levels };
}

function payload(overrides = {}) {
  return Object.assign({
    current: {
      time: (NOW - 15 * 60 * 1000) / 1000,
      wave_height: 1.18,
      wave_period: 6.04,
      sea_surface_temperature: 29.4
    },
    hourly: series()
  }, overrides);
}

function element(id) {
  const node = { id, hidden: id === "sea", textContent: "", children: [] };
  node.appendChild = child => { node.children.push(child); return child; };
  node.removeChild = child => { node.children.splice(node.children.indexOf(child), 1); return child; };
  Object.defineProperty(node, "firstChild", { get: () => node.children[0] || null });
  return node;
}

function createSea(responses, now = NOW) {
  const elements = {};
  for (const id of ["sea", "sea-waves", "sea-detail", "sea-chart", "sea-tide"]) elements[id] = element(id);
  const timers = new Map();
  let timerID = 0;
  const requests = [];
  const document = {
    hidden: false,
    getElementById(id) { return elements[id] || null; },
    createElementNS(namespace, name) {
      const attributes = {};
      return { namespace, name, attributes, setAttribute(key, value) { attributes[key] = value; } };
    },
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
  const clock = { now };
  const RealDate = Date;
  class FixedDate extends RealDate {
    constructor(...args) { super(...(args.length ? args : [clock.now])); }
    static now() { return clock.now; }
  }
  vm.runInNewContext(source, { window, document, console, Date: FixedDate }, { filename: "sea.js" });
  return { sea: window.LauncherSea, elements, timers, requests, clock };
}

const settle = () => new Promise(resolve => setImmediate(resolve));

function expiryTimer(h) {
  return [...h.timers.values()].find(timer => timer.callback.name === "hide");
}

test("shows waves, water and the next tides from the marine API", async () => {
  const h = createSea([payload()]);
  await settle();
  const request = new URL(h.requests[0].url);
  assert.equal(request.origin, "https://marine-api.open-meteo.com");
  assert.equal(request.searchParams.get("timeformat"), "unixtime");
  assert.equal(request.searchParams.get("hourly"), "sea_level_height_msl");
  assert.equal(h.requests[0].options.credentials, "omit");
  assert.equal(h.elements.sea.hidden, false);
  assert.equal(h.elements["sea-waves"].textContent, "1,18 m");
  assert.equal(h.elements["sea-detail"].textContent, "a cada 6 s · água 29 °C");
  assert.equal(h.elements["sea-tide"].textContent, "Baixa ~11:15 · Alta ~17:30");
  assert.deepEqual(
    h.elements["sea-chart"].children.map(node => [node.name, node.attributes.class]),
    [["path", "tide-area"], ["path", "tide-line"], ["line", "tide-now-line"], ["circle", "tide-now"]]
  );
  assert.equal(h.elements["sea-chart"].children[3].attributes.cx, "75");
});

test("finds each turn within two minutes and shifts it by the calibrated lag", () => {
  const { sea } = createSea([new Error("offline")]);
  const tides = sea.parse(payload()).tides;
  const expected = [];
  // The series runs from -24 h to +47 h, so turns need a sample on each side.
  for (let n = -6; n <= 10; n += 1) {
    const model = MODEL_HIGH + n * PERIOD / 2;
    if (model > MIDNIGHT - 23 * HOUR && model < MIDNIGHT + 46 * HOUR) {
      expected.push({ time: model + LAG, high: n % 2 === 0 });
    }
  }
  assert.equal(tides.length, expected.length);
  tides.forEach((turn, index) => {
    assert.equal(turn.high, expected[index].high);
    assert.ok(Math.abs(turn.time - expected[index].time) < 2 * 60 * 1000, new Date(turn.time).toString());
    assert.ok(Math.abs(Math.abs(turn.level) - 1.2) < 0.02);
  });
  assert.ok(Math.abs(sea.levelAt(tides, tides[1].time) - tides[1].level) < 1e-9);
  assert.equal(sea.levelAt(tides, tides[0].time - HOUR), null);
});

test("tolerates missing levels and water temperature", async () => {
  const hourly = series();
  hourly.sea_level_height_msl[30] = null;
  const h = createSea([payload({
    hourly,
    current: Object.assign(payload().current, { sea_surface_temperature: null })
  })]);
  await settle();
  assert.equal(h.elements.sea.hidden, false);
  assert.equal(h.elements["sea-detail"].textContent, "a cada 6 s");
  assert.equal(h.elements["sea-tide"].textContent, "Baixa ~11:15 · Alta ~17:30");
});

test("a small wobble does not add a turn", () => {
  const { sea } = createSea([new Error("offline")]);
  const clean = sea.parse(payload()).tides;
  // At 13:00 the rising tide reads -0.74, 0.5, 0.41, 0.91: a false high and low three hours after a low.
  const hourly = series(undefined, undefined, time => time === MIDNIGHT + 13 * HOUR
    ? 0.5
    : 1.2 * Math.cos(2 * Math.PI * (time - MODEL_HIGH) / PERIOD));
  const tides = sea.parse(payload({ hourly })).tides;
  assert.deepEqual(tides.map(turn => turn.high), clean.map(turn => turn.high));
  tides.forEach((turn, index) => assert.ok(Math.abs(turn.time - clean[index].time) < 2 * 60 * 1000));
});

test("rejects malformed forecasts and keeps the card hidden", async () => {
  const { sea } = createSea([new Error("offline")]);
  const gap = series();
  gap.time[5] += 60;
  const short = series();
  short.sea_level_height_msl.pop();
  for (const value of [
    null,
    {},
    payload({ hourly: gap }),
    payload({ hourly: short }),
    payload({ hourly: series(undefined, 12) }),
    payload({ current: Object.assign(payload().current, { wave_height: -1 }) }),
    payload({ current: Object.assign(payload().current, { wave_period: "6" }) }),
    payload({ current: Object.assign(payload().current, { time: 1.5 }) }),
    payload({ hourly: Object.assign(series(), { sea_level_height_msl: series().sea_level_height_msl.map(() => 9) }) })
  ]) {
    assert.equal(sea.parse(value), null);
  }
  const h = createSea([payload({ hourly: gap })]);
  await settle();
  assert.equal(h.elements.sea.hidden, true);
  assert.equal(h.elements["sea-chart"].children.length, 0);
});

test("keeps the last forecast after a failed refresh, then hides it when it expires", async () => {
  const h = createSea([payload(), new Error("offline")]);
  await settle();
  assert.equal(h.elements.sea.hidden, false);
  h.clock.now = NOW + 30 * 60 * 1000;
  await h.sea.refresh();
  assert.equal(h.elements.sea.hidden, false);
  assert.equal(h.requests.length, 2);
  const expiry = expiryTimer(h);
  assert.equal(expiry.delay, 6 * HOUR - 45 * 60 * 1000);
  expiry.callback();
  assert.equal(h.elements.sea.hidden, true);
});

test("hides stale data and series without two upcoming turns", async () => {
  const stale = createSea([payload({ current: Object.assign(payload().current, { time: (NOW - 7 * HOUR) / 1000 }) })]);
  await settle();
  assert.equal(stale.elements.sea.hidden, true);
  const ended = createSea([payload({ hourly: series(MIDNIGHT - 30 * HOUR, 36) })]);
  await settle();
  assert.equal(ended.elements.sea.hidden, true);
});
