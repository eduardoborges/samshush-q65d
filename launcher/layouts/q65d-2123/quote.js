/* US dollar in reais from AwesomeAPI: https://docs.awesomeapi.com.br/api-de-moedas */
(function () {
  "use strict";

  var url = "https://economia.awesomeapi.com.br/json/last/USD-BRL";
  var refreshDelay = 10 * 60 * 1000;
  var requestTimeout = 15 * 1000;
  // The market closes on weekends and holidays, so a Friday quote is still the latest one on Monday.
  var maxAge = 4 * 24 * 60 * 60 * 1000;
  var container = document.getElementById("quote");
  var price = document.getElementById("quote-price");
  var change = document.getElementById("quote-change");
  var time = document.getElementById("quote-time");
  var refreshTimer = null;
  var expiryTimer = null;
  var busy = false;
  var stopped = false;
  var lastQuote = null;

  function parse(value) {
    var quote = value && value.USDBRL;
    if (!quote || quote.code !== "USD" || quote.codein !== "BRL") return null;
    var bid = Number(quote.bid);
    var percent = Number(quote.pctChange);
    var seconds = Number(quote.timestamp);
    if (!Number.isFinite(bid) || bid <= 0 || bid >= 100 ||
        !Number.isFinite(percent) || Math.abs(percent) >= 50 ||
        !Number.isInteger(seconds) || seconds <= 0) return null;
    return { bid: bid, change: percent, time: seconds * 1000 };
  }

  function decimal(value) {
    return value.toFixed(2).replace(".", ",");
  }

  function twoDigits(value) {
    return String(value).padStart(2, "0");
  }

  function format(quote, now) {
    var at = new Date(quote.time);
    var today = new Date(now);
    var clock = twoDigits(at.getHours()) + ":" + twoDigits(at.getMinutes());
    var sameDay = at.getFullYear() === today.getFullYear() && at.getMonth() === today.getMonth() &&
      at.getDate() === today.getDate();
    var rounded = Math.round(quote.change * 100) / 100;
    return {
      price: "R$ " + decimal(quote.bid),
      change: (rounded > 0 ? "+" : rounded < 0 ? "−" : "") + decimal(Math.abs(rounded)) + "%",
      direction: rounded > 0 ? "up" : rounded < 0 ? "down" : "flat",
      time: sameDay ? "às " + clock : twoDigits(at.getDate()) + "/" + twoDigits(at.getMonth() + 1) + " " + clock
    };
  }

  function hide() {
    lastQuote = null;
    container.hidden = true;
  }

  function render(quote) {
    var now = Date.now();
    if (now - quote.time > maxAge) { hide(); return; }
    var text = format(quote, now);
    lastQuote = quote;
    price.textContent = text.price;
    change.textContent = text.change;
    change.className = "quote-change " + text.direction;
    time.textContent = text.time;
    container.hidden = false;
    window.clearTimeout(expiryTimer);
    expiryTimer = window.setTimeout(hide, quote.time + maxAge - now);
  }

  function request() {
    var controller = new window.AbortController();
    var timer = window.setTimeout(function () { controller.abort(); }, requestTimeout);
    return window.fetch(url, {
      signal: controller.signal,
      credentials: "omit",
      referrerPolicy: "no-referrer"
    }).then(function (response) {
      if (!response.ok) throw new Error("Quote request failed");
      return response.json();
    }).finally(function () { window.clearTimeout(timer); });
  }

  function schedule() {
    window.clearTimeout(refreshTimer);
    if (!stopped && !document.hidden) refreshTimer = window.setTimeout(refresh, refreshDelay);
  }

  function refresh() {
    if (busy || stopped) return Promise.resolve(lastQuote);
    busy = true;
    window.clearTimeout(refreshTimer);
    return request().then(function (value) {
      var quote = parse(value);
      if (!quote) throw new Error("Unexpected quote data");
      if (!stopped) render(quote);
      return quote;
    }).catch(function () {
      // Keep the last good quote; it hides itself once it is too old.
      return lastQuote;
    }).then(function (quote) {
      busy = false;
      schedule();
      return quote;
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

  window.LauncherQuote = { parse: parse, format: format, refresh: refresh, stop: stop };
  if (!container || !price || !change || !time || typeof window.fetch !== "function" ||
      typeof window.AbortController !== "function") return;
  document.addEventListener("visibilitychange", visibilityChanged);
  refresh();
}());
