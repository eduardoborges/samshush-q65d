/* Fortaleza waves and tide from Open-Meteo Marine: https://open-meteo.com/en/docs/marine-weather-api */
(function () {
  "use strict";

  // Every Fortaleza beach resolves to the same open-sea cell, about 15 km offshore.
  var url = "https://marine-api.open-meteo.com/v1/marine?latitude=-3.72&longitude=-38.48" +
    "&cell_selection=sea&current=wave_height,wave_period,sea_surface_temperature" +
    "&hourly=sea_level_height_msl&past_days=1&forecast_days=2&timeformat=unixtime" +
    "&timezone=America%2FFortaleza";
  var hour = 60 * 60 * 1000;
  var refreshDelay = 30 * 60 * 1000;
  var requestTimeout = 15 * 1000;
  var maxAge = 6 * hour;
  // The model's tide runs early on this coast. Against the Porto do Mucuripe table for
  // 28 Oct to 8 Nov 2026 it led by 33 to 85 minutes, 65 on average. Shifting by the mean
  // leaves the times within about half an hour, so they are shown rounded and approximate.
  var tideLag = 65 * 60 * 1000;
  // The Porto do Mucuripe table measures from chart datum, 1.35 m below the model's mean sea level.
  // Across 27 turns O POVO published for 3 to 11 Nov 2026, the table matched the model plus that
  // offset within 0.17 m. Heights add it and keep one decimal, like the table.
  var chartDatum = 1.35;
  // The chart shows the past 6 hours and the next 18, on a fixed scale so spring tides look bigger.
  var chartBefore = 6 * hour;
  var chartAfter = 18 * hour;
  var chartWidth = 300;
  var chartHeight = 72;
  var lowest = -1.6;
  var highest = 1.8;
  var svg = "http://www.w3.org/2000/svg";
  var container = document.getElementById("sea");
  var waves = document.getElementById("sea-waves");
  var detail = document.getElementById("sea-detail");
  var chart = document.getElementById("sea-chart");
  var tide = document.getElementById("sea-tide");
  var refreshTimer = null;
  var expiryTimer = null;
  var busy = false;
  var stopped = false;
  var lastSea = null;

  function within(value, low, high) {
    return typeof value === "number" && Number.isFinite(value) && value >= low && value <= high;
  }

  // Turning points of the hourly series, refined with a parabola through each point and its neighbours.
  function extremes(levels) {
    var found = [];
    for (var i = 1; i < levels.length - 1; i += 1) {
      var a = levels[i - 1].level;
      var b = levels[i].level;
      var c = levels[i + 1].level;
      if (a === null || b === null || c === null) continue;
      var high = b > a && b >= c;
      if (!high && !(b < a && b <= c)) continue;
      var bend = a - 2 * b + c;
      var turn = {
        time: levels[i].time + (a - c) / (2 * bend) * hour,
        level: b - (a - c) * (a - c) / (8 * bend),
        high: high
      };
      var last = found[found.length - 1];
      if (last && last.high === turn.high) {
        // Two highs or two lows in a row mean a wobble in between; keep the stronger turn.
        if (turn.high ? turn.level > last.level : turn.level < last.level) found[found.length - 1] = turn;
      } else if (!last || turn.time - last.time >= 3 * hour) {
        found.push(turn);
      }
    }
    return found;
  }

  function parse(value) {
    var current = value && value.current;
    var hourly = value && value.hourly;
    if (!current || !hourly || !Array.isArray(hourly.time) ||
        !Array.isArray(hourly.sea_level_height_msl) ||
        hourly.time.length !== hourly.sea_level_height_msl.length || hourly.time.length < 24) return null;
    if (!Number.isInteger(current.time) || current.time <= 0 ||
        !within(current.wave_height, 0, 20) || !within(current.wave_period, 0, 30)) return null;
    var water = current.sea_surface_temperature;
    if (water !== null && !within(water, 0, 40)) return null;
    var levels = [];
    for (var i = 0; i < hourly.time.length; i += 1) {
      var time = hourly.time[i];
      var level = hourly.sea_level_height_msl[i];
      if (!Number.isInteger(time) || (i > 0 && time - hourly.time[i - 1] !== 3600)) return null;
      if (level !== null && !within(level, -5, 5)) return null;
      levels.push({ time: time * 1000 + tideLag, level: level });
    }
    var tides = extremes(levels);
    if (tides.length < 2) return null;
    return {
      time: current.time * 1000,
      waves: current.wave_height,
      period: current.wave_period,
      water: water,
      tides: tides
    };
  }

  // Half a cosine between consecutive turns, the usual way to draw a tide from its highs and lows.
  function levelAt(tides, time) {
    for (var i = 1; i < tides.length; i += 1) {
      var from = tides[i - 1];
      var to = tides[i];
      if (time >= from.time && time <= to.time && from.high !== to.high) {
        var phase = (time - from.time) / (to.time - from.time);
        return (from.level + to.level) / 2 + (from.level - to.level) / 2 * Math.cos(Math.PI * phase);
      }
    }
    return null;
  }

  function twoDigits(value) {
    return String(value).padStart(2, "0");
  }

  function clock(time) {
    var quarter = 15 * 60 * 1000;
    var at = new Date(Math.round(time / quarter) * quarter);
    return twoDigits(at.getHours()) + ":" + twoDigits(at.getMinutes());
  }

  // Round first, so a height just under zero shows 0,0 and not -0,0.
  function meters(value) {
    return (Math.round(value * 10) / 10).toFixed(1).replace(".", ",") + " m";
  }

  function format(sea, now) {
    var next = sea.tides.filter(function (turn) { return turn.time > now; }).slice(0, 2);
    if (next.length < 2) return null;
    return {
      waves: sea.waves.toFixed(2).replace(".", ",") + " m",
      detail: "a cada " + Math.round(sea.period) + " s" +
        (sea.water === null ? "" : " · água " + Math.round(sea.water) + " °C"),
      tide: next.map(function (turn) {
        return (turn.high ? "Alta" : "Baixa") + " ~" + clock(turn.time) + " " + meters(turn.level + chartDatum);
      }).join(" · ")
    };
  }

  function chartPoints(sea, now) {
    var start = now - chartBefore;
    var span = chartBefore + chartAfter;
    var points = [];
    for (var step = 0; step <= 96; step += 1) {
      var time = start + span * step / 96;
      var level = levelAt(sea.tides, time);
      if (level === null) continue;
      var clamped = Math.max(lowest, Math.min(highest, level));
      points.push({
        x: Math.round(chartWidth * (time - start) / span * 10) / 10,
        y: Math.round((chartHeight - 8 - (clamped - lowest) / (highest - lowest) * (chartHeight - 16)) * 10) / 10
      });
    }
    return points;
  }

  function shape(name, attributes) {
    var node = document.createElementNS(svg, name);
    Object.keys(attributes).forEach(function (key) { node.setAttribute(key, String(attributes[key])); });
    chart.appendChild(node);
  }

  function draw(sea, now) {
    while (chart.firstChild) chart.removeChild(chart.firstChild);
    var points = chartPoints(sea, now);
    if (points.length < 2) return;
    var line = points.map(function (point) { return point.x + " " + point.y; }).join(" L");
    var first = points[0];
    var last = points[points.length - 1];
    shape("path", {
      class: "tide-area",
      d: "M" + first.x + " " + chartHeight + " L" + line + " L" + last.x + " " + chartHeight + " Z"
    });
    shape("path", { class: "tide-line", d: "M" + line });
    var x = chartWidth * chartBefore / (chartBefore + chartAfter);
    var marker = points.reduce(function (best, point) {
      return Math.abs(point.x - x) < Math.abs(best.x - x) ? point : best;
    });
    shape("line", { class: "tide-now-line", x1: marker.x, x2: marker.x, y1: 0, y2: chartHeight });
    shape("circle", { class: "tide-now", cx: marker.x, cy: marker.y, r: 5 });
  }

  function hide() {
    lastSea = null;
    container.hidden = true;
  }

  function render(sea) {
    var now = Date.now();
    var text = now - sea.time <= maxAge ? format(sea, now) : null;
    if (!text) { hide(); return; }
    lastSea = sea;
    waves.textContent = text.waves;
    detail.textContent = text.detail;
    tide.textContent = text.tide;
    draw(sea, now);
    container.hidden = false;
    window.clearTimeout(expiryTimer);
    expiryTimer = window.setTimeout(hide, sea.time + maxAge - now);
  }

  function request() {
    var controller = new window.AbortController();
    var timer = window.setTimeout(function () { controller.abort(); }, requestTimeout);
    return window.fetch(url, {
      signal: controller.signal,
      credentials: "omit",
      referrerPolicy: "no-referrer"
    }).then(function (response) {
      if (!response.ok) throw new Error("Sea request failed");
      return response.json();
    }).finally(function () { window.clearTimeout(timer); });
  }

  function schedule() {
    window.clearTimeout(refreshTimer);
    if (!stopped && !document.hidden) refreshTimer = window.setTimeout(refresh, refreshDelay);
  }

  function refresh() {
    if (busy || stopped) return Promise.resolve(lastSea);
    busy = true;
    window.clearTimeout(refreshTimer);
    return request().then(function (value) {
      var sea = parse(value);
      if (!sea) throw new Error("Unexpected sea data");
      return sea;
    }).catch(function () {
      // Keep the last good forecast and move the chart on; it hides itself once it is too old.
      return lastSea;
    }).then(function (sea) {
      if (sea && !stopped) render(sea);
      busy = false;
      schedule();
      return lastSea;
    });
  }

  function visibilityChanged() {
    if (document.hidden) window.clearTimeout(refreshTimer);
    else refresh();
  }

  function stop() {
    stopped = true;
    window.clearTimeout(refreshTimer);
    window.clearTimeout(expiryTimer);
    document.removeEventListener("visibilitychange", visibilityChanged);
  }

  window.LauncherSea = {
    parse: parse,
    extremes: extremes,
    levelAt: levelAt,
    format: format,
    refresh: refresh,
    stop: stop
  };
  if (!container || !waves || !detail || !chart || !tide || typeof window.fetch !== "function" ||
      typeof window.AbortController !== "function" || typeof document.createElementNS !== "function") return;
  document.addEventListener("visibilitychange", visibilityChanged);
  refresh();
}());
