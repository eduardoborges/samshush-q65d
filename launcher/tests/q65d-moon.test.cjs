const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const source = fs.readFileSync(
  path.join(__dirname, "..", "layouts", "q65d-2123", "moon.js"),
  "utf8"
);
const NOW = new Date(2026, 10, 11, 9, 30).getTime();

function createMoon(now = NOW, withElements = true) {
  const elements = {};
  for (const id of ["moon", "moon-name", "moon-light", "moon-tide", "moon-tide-detail"]) {
    elements[id] = { id, hidden: id === "moon", textContent: "" };
  }
  const timers = new Map();
  let timerID = 0;
  const document = {
    hidden: false,
    getElementById(id) { return withElements ? elements[id] || null : null; },
    addEventListener() {},
    removeEventListener() {}
  };
  const window = {
    setTimeout(callback, delay) { timers.set(++timerID, { callback, delay }); return timerID; },
    clearTimeout(id) { timers.delete(id); }
  };
  const RealDate = Date;
  class FixedDate extends RealDate {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  }
  vm.runInNewContext(source, { window, document, Date: FixedDate }, { filename: "moon.js" });
  return { moon: window.LauncherMoon, elements, timers };
}

// k counts lunations from the January 2000 new moon; full moons sit halfway.
const lunation = iso => Math.round(((Date.parse(iso) / 86400000 + 2440587.5) - 2451550.09766) / 29.530588861 * 2) / 2;

test("new and full moon times land within five minutes of published ones", () => {
  const { moon } = createMoon(NOW, false);
  for (const [label, iso] of [
    ["Meeus example 49.a, new moon", "1977-02-18T03:37:42Z"],
    ["new moon of the April 2024 eclipse", "2024-04-08T18:21:00Z"],
    ["full moon of January 2024", "2024-01-25T17:54:00Z"]
  ]) {
    const error = Math.abs(moon.phaseTime(lunation(iso)) - Date.parse(iso));
    assert.ok(error < 5 * 60 * 1000, `${label}: ${error / 60000} min`);
  }
});

test("names the phase, its light and the next spring tide", () => {
  const { moon } = createMoon(NOW, false);
  const at = (...args) => JSON.parse(JSON.stringify(moon.describe(new Date(...args).getTime())));
  assert.deepEqual(at(2026, 10, 11, 9, 30),
    { name: "Crescente", light: "5% iluminada", tide: "24/11", tideDetail: "lua cheia" });
  assert.deepEqual(at(2026, 10, 24, 12, 0),
    { name: "Lua cheia", light: "100% iluminada", tide: "Agora", tideDetail: "lua cheia" });
  assert.deepEqual(at(2026, 10, 30, 12, 0),
    { name: "Minguante", light: "60% iluminada", tide: "08/12", tideDetail: "lua nova" });
  assert.deepEqual(at(2026, 10, 9, 10, 0),
    { name: "Lua nova", light: "0% iluminada", tide: "Agora", tideDetail: "lua nova" });
});

test("shows the card, rechecks every hour and stop cancels it", () => {
  const h = createMoon();
  assert.equal(h.elements.moon.hidden, false);
  assert.deepEqual(["moon-name", "moon-light", "moon-tide", "moon-tide-detail"].map(id => h.elements[id].textContent),
    ["Crescente", "5% iluminada", "24/11", "lua cheia"]);
  assert.deepEqual([...h.timers.values()].map(timer => timer.delay), [60 * 60 * 1000]);
  h.moon.stop();
  assert.equal(h.timers.size, 0);
});
