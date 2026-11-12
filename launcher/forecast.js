/* Fortaleza weather from the Open-Meteo forecast API: https://open-meteo.com/en/docs
   It fills the wind column of the beach card and the forecast panel below the top cards. */
(function () {
  "use strict";

  var url = "https://api.open-meteo.com/v1/forecast?latitude=-3.72&longitude=-38.52" +
    "&current=temperature_2m,apparent_temperature,relative_humidity_2m,wind_speed_10m,wind_gusts_10m" +
    "&hourly=uv_index&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max" +
    "&forecast_days=3&timeformat=unixtime&timezone=America%2FFortaleza&wind_speed_unit=kmh";
  var hour = 60 * 60 * 1000;
  var refreshDelay = 30 * 60 * 1000;
  var requestTimeout = 15 * 1000;
  var maxAge = 6 * hour;
  // The UV peak covers the same 18 hours ahead as the tide chart next to it.
  var uvAhead = 18 * hour;
  // Short names for the WMO weather codes Open-Meteo reports.
  var conditions = [
    [[0], "Céu limpo"], [[1], "Poucas nuvens"], [[2], "Sol e nuvens"], [[3], "Nublado"],
    [[45, 48], "Neblina"], [[51, 53, 55, 56, 57], "Garoa"], [[61, 63, 65, 66, 67], "Chuva"],
    [[71, 73, 75, 77, 85, 86], "Neve"], [[80, 81, 82], "Pancadas"], [[95, 96, 99], "Trovoadas"]
  ];
  var airColumn = document.getElementById("sea-air");
  var wind = document.getElementById("sea-wind");
  var windDetail = document.getElementById("sea-weather");
  var panel = document.getElementById("forecast");
  var current = document.getElementById("forecast-now");
  var currentDetail = document.getElementById("forecast-now-detail");
  var dayFields = [0, 1].map(function (index) {
    return {
      date: document.getElementById("forecast-" + index + "-date"),
      high: document.getElementById("forecast-" + index + "-high"),
      low: document.getElementById("forecast-" + index + "-low"),
      detail: document.getElementById("forecast-" + index + "-detail")
    };
  });
  var refreshTimer = null;
  var expiryTimer = null;
  var busy = false;
  var stopped = false;
  var lastWeather = null;

  function within(value, low, high) {
    return typeof value === "number" && Number.isFinite(value) && value >= low && value <= high;
  }

  function readings(list, low, high) {
    return Array.isArray(list) && list.every(function (value) {
      return value === null || within(value, low, high);
    });
  }

  function parse(value) {
    var now = value && value.current;
    var hourly = value && value.hourly;
    var daily = value && value.daily;
    if (!now || !hourly || !daily || !Number.isInteger(now.time) || now.time <= 0 ||
        !within(now.temperature_2m, -50, 60) || !within(now.apparent_temperature, -60, 70) ||
        !within(now.relative_humidity_2m, 0, 100) || !within(now.wind_speed_10m, 0, 300) ||
        !within(now.wind_gusts_10m, 0, 400) ||
        !Array.isArray(hourly.time) || !hourly.time.every(Number.isInteger) ||
        !readings(hourly.uv_index, 0, 25) || hourly.uv_index.length !== hourly.time.length ||
        !Array.isArray(daily.time) || !daily.time.every(Number.isInteger) ||
        !readings(daily.temperature_2m_max, -50, 60) || !readings(daily.temperature_2m_min, -50, 60) ||
        !readings(daily.precipitation_probability_max, 0, 100) || !Array.isArray(daily.weather_code) ||
        !daily.weather_code.every(function (code) { return code === null || Number.isInteger(code); }) ||
        [daily.temperature_2m_max, daily.temperature_2m_min, daily.precipitation_probability_max,
          daily.weather_code].some(function (list) { return list.length !== daily.time.length; })) return null;
    return {
      time: now.time * 1000,
      temperature: now.temperature_2m,
      feelsLike: now.apparent_temperature,
      humidity: now.relative_humidity_2m,
      wind: now.wind_speed_10m,
      gusts: now.wind_gusts_10m,
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

  function degrees(value) {
    return Math.round(value) + "°";
  }

  function twoDigits(value) {
    return String(value).padStart(2, "0");
  }

  // Days are matched to the TV's calendar, so a forecast fetched before midnight still labels them
  // right. That is why the request asks for three days: tomorrow is still there after midnight.
  function dayAfter(weather, now, offset) {
    var today = new Date(now);
    var day = new Date(today.getFullYear(), today.getMonth(), today.getDate() + offset);
    var entry = weather.days.filter(function (candidate) {
      var at = new Date(candidate.time);
      return at.getFullYear() === day.getFullYear() && at.getMonth() === day.getMonth() &&
        at.getDate() === day.getDate();
    })[0];
    if (!entry || entry.high === null || entry.low === null) return null;
    return {
      date: twoDigits(day.getDate()) + "/" + twoDigits(day.getMonth() + 1),
      high: degrees(entry.high),
      low: degrees(entry.low),
      sky: condition(entry.code) || "",
      rain: entry.rain === null ? "" : Math.round(entry.rain) + "%"
    };
  }

  function format(weather, now) {
    if (!weather || now - weather.time > maxAge) return null;
    var uv = weather.uv.reduce(function (top, entry) {
      var ahead = entry.time > now - hour && entry.time <= now + uvAhead;
      return !ahead || entry.value === null || (top !== null && top >= entry.value) ? top : entry.value;
    }, null);
    var windParts = ["rajadas " + Math.round(weather.gusts) + " km/h"];
    if (uv !== null) windParts.push("UV máx. " + Math.round(uv));
    var days = [0, 1].map(function (offset) { return dayAfter(weather, now, offset); });
    return {
      wind: Math.round(weather.wind) + " km/h",
      windDetail: windParts.join(" · "),
      now: degrees(weather.temperature),
      nowDetail: "sensação " + degrees(weather.feelsLike) + " · umidade " + Math.round(weather.humidity) + "%",
      days: days[0] && days[1] ? days.map(function (day) {
        return {
          date: day.date,
          high: day.high,
          low: day.low,
          detail: [day.sky, day.rain && "chuva " + day.rain].filter(Boolean).join(" · ")
        };
      }) : null
    };
  }

  function render() {
    var now = Date.now();
    var text = format(lastWeather, now);
    airColumn.hidden = !text;
    panel.hidden = !text || !text.days;
    window.clearTimeout(expiryTimer);
    if (!text) return;
    wind.textContent = text.wind;
    windDetail.textContent = text.windDetail;
    if (text.days) {
      current.textContent = text.now;
      currentDetail.textContent = text.nowDetail;
      text.days.forEach(function (day, index) {
        dayFields[index].date.textContent = day.date;
        dayFields[index].high.textContent = day.high;
        dayFields[index].low.textContent = day.low;
        dayFields[index].detail.textContent = day.detail;
      });
    }
    expiryTimer = window.setTimeout(render, lastWeather.time + maxAge - now);
  }

  function request() {
    var controller = new window.AbortController();
    var timer = window.setTimeout(function () { controller.abort(); }, requestTimeout);
    return window.fetch(url, {
      signal: controller.signal,
      credentials: "omit",
      referrerPolicy: "no-referrer"
    }).then(function (response) {
      if (!response.ok) throw new Error("Forecast request failed");
      return response.json();
    }).finally(function () { window.clearTimeout(timer); });
  }

  function schedule() {
    window.clearTimeout(refreshTimer);
    if (!stopped && !document.hidden) refreshTimer = window.setTimeout(refresh, refreshDelay);
  }

  function refresh() {
    if (busy || stopped) return Promise.resolve(lastWeather);
    busy = true;
    window.clearTimeout(refreshTimer);
    // Keep the last good forecast when a request fails; render hides it once it is too old.
    return request().then(parse).catch(function () { return null; }).then(function (weather) {
      if (weather) lastWeather = weather;
      if (!stopped) render();
      busy = false;
      schedule();
      return lastWeather;
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

  window.LauncherForecast = { parse: parse, format: format, refresh: refresh, stop: stop };
  var fields = dayFields.reduce(function (all, day) {
    return all.concat([day.date, day.high, day.low, day.detail]);
  }, []);
  if (!airColumn || !wind || !windDetail || !panel || !current || !currentDetail ||
      fields.some(function (field) { return !field; }) || typeof window.fetch !== "function" ||
      typeof window.AbortController !== "function") return;
  document.addEventListener("visibilitychange", visibilityChanged);
  refresh();
}());
