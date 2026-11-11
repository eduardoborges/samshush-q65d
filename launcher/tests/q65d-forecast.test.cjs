const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const source = fs.readFileSync(
  path.join(__dirname, "..", "layouts", "q65d-2123", "forecast.js"),
  "utf8"
);
const HOUR = 3600 * 1000;
const MIDNIGHT = new Date(2026, 10, 11, 0, 0).getTime();
// A Wednesday morning.
const NOW = new Date(2026, 10, 11, 9, 30).getTime();
const day = offset => new Date(2026, 10, 11 + offset).getTime() / 1000;

function payload(overrides = {}) {
  const time = [];
  const uv = [];
  for (let i = 0; i < 72; i += 1) {
    const at = new Date(MIDNIGHT + i * HOUR);
    time.push(at.getTime() / 1000);
    // Peaks before 08:30 and after 03:30 tomorrow fall outside the 18 hours ahead.
    uv.push(i === 8 || i === 29 ? 11 : at.getHours() === 12 ? 9.4 : 0);
  }
  return Object.assign({
    current: {
      time: (NOW - 10 * 60 * 1000) / 1000,
      temperature_2m: 27.4,
      apparent_temperature: 31.2,
      relative_humidity_2m: 79,
      wind_speed_10m: 17.2,
      wind_gusts_10m: 36.6
    },
    hourly: { time, uv_index: uv },
    daily: {
      time: [0, 1, 2, 3, 4, 5, 6].map(day),
      weather_code: [80, 2, 0, 3, 61, 95, 51],
      temperature_2m_max: [31.2, 30.4, 32, 30, 29.6, 31, 30.5],
      temperature_2m_min: [24.6, 23.7, 25, 24, 23.4, 24.2, 24.9],
      precipitation_probability_max: [60, 10, 0, 20, 70, 80, null]
    }
  }, overrides);
}

function withDaily(changes) {
  const base = payload();
  return payload({ daily: Object.assign({}, base.daily, changes) });
}

function withCurrent(changes) {
  return payload({ current: Object.assign({}, payload().current, changes) });
}

function element(id) {
  const node = { id, hidden: ["sea-air", "forecast"].includes(id), textContent: "", className: "", children: [] };
  node.appendChild = child => { node.children.push(child); return child; };
  node.removeChild = child => { node.children.splice(node.children.indexOf(child), 1); return child; };
  Object.defineProperty(node, "firstChild", { get: () => node.children[0] || null });
  return node;
}

function createForecast(responses) {
  const elements = {};
  for (const id of ["sea-air", "sea-wind", "sea-weather", "forecast", "forecast-now", "forecast-now-detail",
    "forecast-0-date", "forecast-0-high", "forecast-0-low", "forecast-0-detail", "forecast-1-date",
    "forecast-1-high", "forecast-1-low", "forecast-1-detail", "forecast-week"]) elements[id] = element(id);
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
  vm.runInNewContext(source, { window, document, console, Date: FixedDate }, { filename: "forecast.js" });
  return { forecast: window.LauncherForecast, elements, timers, requests, clock };
}

const settle = () => new Promise(resolve => setImmediate(resolve));
const text = (h, id) => h.elements[id].textContent;
const weekRows = h => h.elements["forecast-week"].children.map(row => row.children.map(cell => cell.textContent));

test("fills the wind column with wind, gusts and the UV peak over the next 18 hours", async () => {
  const h = createForecast([payload()]);
  await settle();
  const request = new URL(h.requests[0].url);
  assert.equal(request.origin, "https://api.open-meteo.com");
  assert.equal(request.searchParams.get("forecast_days"), "7");
  assert.equal(request.searchParams.get("wind_speed_unit"), "kmh");
  assert.equal(request.searchParams.get("timeformat"), "unixtime");
  assert.equal(h.requests[0].options.credentials, "omit");
  assert.equal(h.elements["sea-air"].hidden, false);
  assert.equal(text(h, "sea-wind"), "17 km/h");
  assert.equal(text(h, "sea-weather"), "rajadas 37 km/h · UV máx. 9");
});

test("shows now, today, tomorrow and the rest of the week", async () => {
  const h = createForecast([payload()]);
  await settle();
  assert.equal(h.elements.forecast.hidden, false);
  assert.equal(text(h, "forecast-now"), "27°");
  assert.equal(text(h, "forecast-now-detail"), "sensação 31° · umidade 79%");
  assert.deepEqual(
    [text(h, "forecast-0-date"), text(h, "forecast-0-high"), text(h, "forecast-0-low"), text(h, "forecast-0-detail")],
    ["11/11", "31°", "25°", "Pancadas · chuva 60%"]
  );
  assert.deepEqual(
    [text(h, "forecast-1-date"), text(h, "forecast-1-high"), text(h, "forecast-1-low"), text(h, "forecast-1-detail")],
    ["12/11", "30°", "24°", "Sol e nuvens · chuva 10%"]
  );
  assert.deepEqual(weekRows(h), [
    ["Sex", "13/11", "Céu limpo", "0%", "32°", "25°"],
    ["Sáb", "14/11", "Nublado", "20%", "30°", "24°"],
    ["Dom", "15/11", "Chuva", "70%", "30°", "23°"],
    ["Seg", "16/11", "Trovoadas", "80%", "31°", "24°"],
    ["Ter", "17/11", "Garoa", "", "31°", "25°"]
  ]);
  assert.deepEqual(h.elements["forecast-week"].children[0].children.map(cell => cell.className),
    ["week-day", "week-date", "week-sky", "week-rain", "week-high", "week-low"]);
});

test("matches days to the TV calendar and leaves out unknown parts", async () => {
  const late = withDaily({
    time: [-1, 0, 1, 2].map(day),
    weather_code: [3, 42, null, 0],
    temperature_2m_max: [29, 31.2, 30.4, 32],
    temperature_2m_min: [22, 24.6, 23.7, 25],
    precipitation_probability_max: [5, 60, null, 0]
  });
  const h = createForecast([late]);
  await settle();
  assert.equal(text(h, "forecast-0-high"), "31°");
  assert.equal(text(h, "forecast-0-detail"), "chuva 60%");
  assert.equal(text(h, "forecast-1-detail"), "");
  assert.deepEqual(weekRows(h), [["Sex", "13/11", "Céu limpo", "0%", "32°", "25°"]]);

  const noTomorrow = createForecast([withDaily({
    time: [-1, 0, 2, 3, 4, 5, 6].map(day)
  })]);
  await settle();
  assert.equal(noTomorrow.elements.forecast.hidden, true);
  assert.equal(noTomorrow.elements["sea-air"].hidden, false);
});

test("hides everything when the forecast fails or is stale, and drops a missing UV", async () => {
  const failed = createForecast([new Error("offline")]);
  await settle();
  assert.equal(failed.elements["sea-air"].hidden, true);
  assert.equal(failed.elements.forecast.hidden, true);

  const stale = createForecast([withCurrent({ time: (NOW - 7 * HOUR) / 1000 })]);
  await settle();
  assert.equal(stale.elements["sea-air"].hidden, true);
  assert.equal(stale.elements.forecast.hidden, true);

  const gaps = payload();
  gaps.hourly.uv_index = gaps.hourly.uv_index.map(() => null);
  const partial = createForecast([gaps]);
  await settle();
  assert.equal(text(partial, "sea-weather"), "rajadas 37 km/h");
});

test("rejects malformed forecasts", () => {
  const { forecast } = createForecast([new Error("offline")]);
  const base = payload();
  for (const value of [
    null,
    withCurrent({ wind_gusts_10m: undefined }),
    withCurrent({ temperature_2m: "27" }),
    withCurrent({ relative_humidity_2m: 120 }),
    withCurrent({ time: 1.5 }),
    payload({ hourly: { time: base.hourly.time, uv_index: base.hourly.uv_index.slice(1) } }),
    payload({ hourly: { time: base.hourly.time, uv_index: base.hourly.uv_index.map(() => -1) } }),
    withDaily({ temperature_2m_max: base.daily.temperature_2m_max.map(() => 99) }),
    withDaily({ precipitation_probability_max: base.daily.precipitation_probability_max.map(() => 120) }),
    withDaily({ weather_code: base.daily.weather_code.map(() => 1.5) }),
    withDaily({ temperature_2m_min: base.daily.temperature_2m_min.slice(1) }),
    payload({ daily: undefined })
  ]) {
    assert.equal(forecast.parse(value), null);
  }
});

test("keeps the last reading after a failed refresh and hides it when it expires", async () => {
  const h = createForecast([withCurrent({ time: (NOW - 5 * HOUR) / 1000, wind_speed_10m: 30 }), new Error("offline")]);
  await settle();
  assert.equal(text(h, "sea-wind"), "30 km/h");
  await h.forecast.refresh();
  assert.equal(h.requests.length, 2);
  assert.equal(h.elements.forecast.hidden, false);
  assert.equal(weekRows(h).length, 5);
  const expiry = [...h.timers.values()].find(timer => timer.callback.name === "render");
  assert.equal(expiry.delay, HOUR);
  h.clock.now = NOW + HOUR + 1;
  expiry.callback();
  assert.equal(h.elements["sea-air"].hidden, true);
  assert.equal(h.elements.forecast.hidden, true);
});
