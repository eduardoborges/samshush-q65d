/* Moon phase computed on the TV, with no network request. New and full moon times use the
   main periodic terms of Meeus, Astronomical Algorithms (2nd ed.), chapter 49, which keep
   them within a few minutes; the date shown only needs the right day. */
(function () {
  "use strict";

  var day = 24 * 60 * 60 * 1000;
  var synodicMonth = 29.530588861;
  // Spring tides come with new and full moon; the card flags the days around them.
  var springWindow = 1.5 * day;
  var refreshDelay = 60 * 60 * 1000;
  var container = document.getElementById("moon");
  var fields = ["moon-name", "moon-light", "moon-tide", "moon-tide-detail"].map(function (id) {
    return document.getElementById(id);
  });
  var timer = null;
  var stopped = false;

  function radians(degrees) {
    return degrees * Math.PI / 180;
  }

  // k is a whole number for a new moon and ends in .5 for a full moon (Meeus 49.2).
  function phaseTime(k) {
    var t = k / 1236.85;
    var jde = 2451550.09766 + synodicMonth * k + 0.00015437 * t * t - 0.00000015 * t * t * t +
      0.00000000073 * t * t * t * t;
    var e = 1 - 0.002516 * t - 0.0000074 * t * t;
    var sun = radians(2.5534 + 29.1053567 * k - 0.0000014 * t * t - 0.00000011 * t * t * t);
    var moon = radians(201.5643 + 385.81693528 * k + 0.0107582 * t * t + 0.00001238 * t * t * t -
      0.000000058 * t * t * t * t);
    var latitude = radians(160.7108 + 390.67050284 * k - 0.0016118 * t * t - 0.00000227 * t * t * t +
      0.000000011 * t * t * t * t);
    var full = Math.abs(k % 1) === 0.5;
    var c = full
      ? [-0.40614, 0.17302, 0.01614, 0.01043, 0.00734, -0.00515, 0.00209]
      : [-0.40720, 0.17241, 0.01608, 0.01039, 0.00739, -0.00514, 0.00208];
    jde += c[0] * Math.sin(moon) + c[1] * e * Math.sin(sun) + c[2] * Math.sin(2 * moon) +
      c[3] * Math.sin(2 * latitude) + c[4] * e * Math.sin(moon - sun) + c[5] * e * Math.sin(moon + sun) +
      c[6] * e * e * Math.sin(2 * sun);
    // Julian ephemeris day to Unix milliseconds; the ~70 s between TT and UTC does not matter here.
    return (jde - 2440587.5) * day;
  }

  // New and full moons from the month before to the month after the given time.
  function events(now) {
    var base = Math.floor(((now / day + 2440587.5) - 2451550.09766) / synodicMonth);
    var list = [];
    for (var k = base - 1; k <= base + 2; k += 1) {
      list.push({ time: phaseTime(k), full: false });
      list.push({ time: phaseTime(k + 0.5), full: true });
    }
    return list.sort(function (a, b) { return a.time - b.time; });
  }

  function twoDigits(value) {
    return String(value).padStart(2, "0");
  }

  function date(time) {
    var at = new Date(time);
    return twoDigits(at.getDate()) + "/" + twoDigits(at.getMonth() + 1);
  }

  function describe(now) {
    var list = events(now);
    var lastNew = list.filter(function (event) { return !event.full && event.time <= now; }).pop();
    var nextNew = list.filter(function (event) { return !event.full && event.time > now; })[0];
    var near = list.filter(function (event) { return Math.abs(event.time - now) <= springWindow; })[0];
    var upcoming = list.filter(function (event) { return event.time > now; })[0];
    var age = (now - lastNew.time) / (nextNew.time - lastNew.time);
    var lit = Math.round((1 - Math.cos(2 * Math.PI * age)) / 2 * 100);
    var name = near && Math.abs(near.time - now) <= day / 2 ? (near.full ? "Lua cheia" : "Lua nova")
      : age < 0.5 ? "Crescente" : "Minguante";
    var tide = near || upcoming;
    return {
      name: name,
      light: lit + "% iluminada",
      tide: near ? "Agora" : date(upcoming.time),
      tideDetail: tide.full ? "lua cheia" : "lua nova"
    };
  }

  function render() {
    if (stopped) return;
    var text = describe(Date.now());
    [text.name, text.light, text.tide, text.tideDetail].forEach(function (value, index) {
      fields[index].textContent = value;
    });
    container.hidden = false;
    window.clearTimeout(timer);
    if (!document.hidden) timer = window.setTimeout(render, refreshDelay);
  }

  function visibilityChanged() {
    if (document.hidden) window.clearTimeout(timer);
    else render();
  }

  function stop() {
    stopped = true;
    window.clearTimeout(timer);
    document.removeEventListener("visibilitychange", visibilityChanged);
  }

  window.LauncherMoon = { phaseTime: phaseTime, describe: describe, stop: stop };
  if (!container || fields.some(function (field) { return !field; })) return;
  document.addEventListener("visibilitychange", visibilityChanged);
  render();
}());
