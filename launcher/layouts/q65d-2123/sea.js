/* Fortaleza conditions from Open-Meteo. The beach card takes waves and tide from the marine API
   and wind and UV from the forecast API, which also feeds the two-day forecast card.
   https://open-meteo.com/en/docs/marine-weather-api and https://open-meteo.com/en/docs */
(function () {
  "use strict";

  // Every Fortaleza beach resolves to the same open-sea cell, about 15 km offshore.
  var seaUrl = "https://marine-api.open-meteo.com/v1/marine?latitude=-3.72&longitude=-38.48" +
    "&cell_selection=sea&current=wave_height,wave_period,sea_surface_temperature" +
    "&hourly=sea_level_height_msl&past_days=1&forecast_days=2&timeformat=unixtime" +
    "&timezone=America%2FFortaleza";
  var weatherUrl = "https://api.open-meteo.com/v1/forecast?latitude=-3.72&longitude=-38.52" +
    "&current=wind_speed_10m,wind_gusts_10m&hourly=uv_index" +
    "&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max" +
    "&forecast_days=3&timeformat=unixtime&timezone=America%2FFortaleza&wind_speed_unit=kmh";
  var hour = 60 * 60 * 1000;
  var refreshDelay = 30 * 60 * 1000;
  var requestTimeout = 15 * 1000;
  var maxAge = 6 * hour;
  // The model's tide runs early on this coast. Against the Porto do Mucuripe table for
  // 28 Oct to 8 Nov 2026 it led by 33 to 85 minutes, 65 on average. Shifting by the mean
  // leaves the times within about half an hour, so they are shown rounded and approximate.
  var tideLag = 65 * 60 * 1000;
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
  var airColumn = document.getElementById("sea-air");
  var wind = document.getElementById("sea-wind");
  var weatherDetail = document.getElementById("sea-weather");
  var forecast = document.getElementById("forecast");
  var dayFields = [0, 1].map(function (index) {
    return {
      high: document.getElementById("forecast-" + index + "-high"),
      low: document.getElementById("forecast-" + index + "-low"),
      detail: document.getElementById("forecast-" + index + "-detail")
    };
  });
  // Short names for the WMO weather codes Open-Meteo reports.
  var conditions = [
    [[0], "Céu limpo"], [[1], "Poucas nuvens"], [[2], "Sol e nuvens"], [[3], "Nublado"],
    [[45, 48], "Neblina"], [[51, 53, 55, 56, 57], "Garoa"], [[61, 63, 65, 66, 67], "Chuva"],
    [[71, 73, 75, 77, 85, 86], "Neve"], [[80, 81, 82], "Pancadas"], [[95, 96, 99], "Trovoadas"]
  ];
  var refreshTimer = null;
  var expiryTimer = null;
  var busy = false;
  var stopped = false;
  var lastSea = null;
  var lastWeather = null;

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

  function format(sea, now) {
    var next = sea.tides.filter(function (turn) { return turn.time > now; }).slice(0, 2);
    if (next.length < 2) return null;
    return {
      waves: sea.waves.toFixed(1).replace(".", ",") + " m",
      detail: "a cada " + Math.round(sea.period) + " s" +
        (sea.water === null ? "" : " · água " + Math.round(sea.water) + " °C"),
      tide: next.map(function (turn) {
        return (turn.high ? "Alta" : "Baixa") + " ~" + clock(turn.time);
      }).join(" · ")
    };
  }

  function readings(list, low, high) {
    return Array.isArray(list) && list.every(function (value) {
      return value === null || within(value, low, high);
    });
  }

  function parseWeather(value) {
    var current = value && value.current;
    var hourly = value && value.hourly;
    var daily = value && value.daily;
    if (!current || !hourly || !daily || !Number.isInteger(current.time) || current.time <= 0 ||
        !within(current.wind_speed_10m, 0, 300) || !within(current.wind_gusts_10m, 0, 400) ||
        !Array.isArray(hourly.time) || !hourly.time.every(Number.isInteger) ||
        !readings(hourly.uv_index, 0, 25) || hourly.uv_index.length !== hourly.time.length ||
        !Array.isArray(daily.time) || !daily.time.every(Number.isInteger) ||
        !readings(daily.temperature_2m_max, -50, 60) || !readings(daily.temperature_2m_min, -50, 60) ||
        !readings(daily.precipitation_probability_max, 0, 100) || !Array.isArray(daily.weather_code) ||
        !daily.weather_code.every(function (code) { return code === null || Number.isInteger(code); }) ||
        [daily.temperature_2m_max, daily.temperature_2m_min, daily.precipitation_probability_max,
          daily.weather_code].some(function (list) { return list.length !== daily.time.length; })) return null;
    return {
      time: current.time * 1000,
      wind: current.wind_speed_10m,
      gusts: current.wind_gusts_10m,
      uv: hourly.time.map(function (time, index) {
        return { time: time * 1000, value: hourly.uv_index[index] };
      }),
      days: daily.time.map(function (time, index) {
        return {
          time: time * 1000,
          high: daily.temperature_2m_max[index],
          low: daily.temperature_2m_min[index],
          rain: daily.precipitation_probability_max[index],
          code: daily.weather_code[index]
        };
      })
    };
  }

  function condition(code) {
    var match = conditions.filter(function (entry) { return entry[0].indexOf(code) >= 0; })[0];
    return match ? match[1] : null;
  }

  function sameDay(time, day) {
    var at = new Date(time);
    return at.getFullYear() === day.getFullYear() && at.getMonth() === day.getMonth() &&
      at.getDate() === day.getDate();
  }

  // UV is the peak over the hours the tide chart shows ahead. Days are matched to the TV's
  // calendar, so a forecast fetched before midnight still labels today and tomorrow correctly.
  function formatWeather(weather, now) {
    if (!weather || now - weather.time > maxAge) return null;
    var uv = weather.uv.reduce(function (top, entry) {
      var ahead = entry.time > now - hour && entry.time <= now + chartAfter;
      return !ahead || entry.value === null || (top !== null && top >= entry.value) ? top : entry.value;
    }, null);
    var parts = ["rajadas " + Math.round(weather.gusts) + " km/h"];
    if (uv !== null) parts.push("UV máx. " + Math.round(uv));
    var today = new Date(now);
    var tomorrow = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);
    var days = [today, tomorrow].map(function (day) {
      var entry = weather.days.filter(function (candidate) { return sameDay(candidate.time, day); })[0];
      if (!entry || entry.high === null || entry.low === null) return null;
      var details = [];
      var name = condition(entry.code);
      if (name) details.push(name);
      if (entry.rain !== null) details.push("chuva " + Math.round(entry.rain) + "%");
      return {
        high: Math.round(entry.high) + "°",
        low: Math.round(entry.low) + "°",
        detail: details.join(" · ")
      };
    });
    return {
      wind: Math.round(weather.wind) + " km/h",
      detail: parts.join(" · "),
      days: days[0] && days[1] ? days : null
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

  // Each card shows only fresh data and is redrawn when its data gets too old.
  function render() {
    var now = Date.now();
    var text = lastSea && now - lastSea.time <= maxAge ? format(lastSea, now) : null;
    var outdoors = formatWeather(lastWeather, now);
    var expiries = [];
    container.hidden = !text;
    if (text) {
      waves.textContent = text.waves;
      detail.textContent = text.detail;
      tide.textContent = text.tide;
      draw(lastSea, now);
      expiries.push(lastSea.time + maxAge);
    }
    airColumn.hidden = !outdoors;
    forecast.hidden = !outdoors || !outdoors.days;
    if (outdoors) {
      wind.textContent = outdoors.wind;
      weatherDetail.textContent = outdoors.detail;
      expiries.push(lastWeather.time + maxAge);
    }
    if (outdoors && outdoors.days) {
      outdoors.days.forEach(function (day, index) {
        dayFields[index].high.textContent = day.high;
        dayFields[index].low.textContent = day.low;
        dayFields[index].detail.textContent = day.detail;
      });
    }
    window.clearTimeout(expiryTimer);
    if (expiries.length) expiryTimer = window.setTimeout(render, Math.min.apply(Math, expiries) - now);
  }

  function request(url) {
    var controller = new window.AbortController();
    var timer = window.setTimeout(function () { controller.abort(); }, requestTimeout);
    return window.fetch(url, {
      signal: controller.signal,
      credentials: "omit",
      referrerPolicy: "no-referrer"
    }).then(function (response) {
      if (!response.ok) throw new Error("Open-Meteo request failed");
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
    // Each source keeps its last good reading when a request fails; render hides what is too old.
    var sea = request(seaUrl).then(parse).catch(function () { return null; });
    var weather = request(weatherUrl).then(parseWeather).catch(function () { return null; });
    return Promise.all([sea, weather]).then(function (results) {
      if (results[0]) lastSea = results[0];
      if (results[1]) lastWeather = results[1];
      if (!stopped) render();
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
    parseWeather: parseWeather,
    formatWeather: formatWeather,
    refresh: refresh,
    stop: stop
  };
  var fields = dayFields.reduce(function (all, day) { return all.concat([day.high, day.low, day.detail]); }, []);
  if (!container || !waves || !detail || !chart || !tide || !airColumn || !wind || !weatherDetail ||
      !forecast || fields.some(function (field) { return !field; }) || typeof window.fetch !== "function" ||
      typeof window.AbortController !== "function" || typeof document.createElementNS !== "function") return;
  document.addEventListener("visibilitychange", visibilityChanged);
  refresh();
}());
