/* Dollar, euro and bitcoin in reais from AwesomeAPI: https://docs.awesomeapi.com.br/api-de-moedas */
(function () {
  "use strict";

  var url = "https://economia.awesomeapi.com.br/json/last/USD-BRL,EUR-BRL,BTC-BRL";
  var refreshDelay = 10 * 60 * 1000;
  var requestTimeout = 15 * 1000;
  // The market closes on weekends and holidays, so a Friday quote is still the latest one on Monday.
  var maxAge = 4 * 24 * 60 * 60 * 1000;
  // Each pair with its label, its plausible price range and how many decimals the price shows.
  var pairs = [
    { key: "USDBRL", code: "USD", name: "Dólar", low: 0, high: 100, decimals: 2 },
    { key: "EURBRL", code: "EUR", name: "Euro", low: 0, high: 100, decimals: 2 },
    { key: "BTCBRL", code: "BTC", name: "Bitcoin", low: 1000, high: 100000000, decimals: 0 }
  ];
  var container = document.getElementById("market");
  var list = document.getElementById("market-list");
  var refreshTimer = null;
  var expiryTimer = null;
  var busy = false;
  var stopped = false;
  var lastQuotes = null;

  function parseOne(value, pair) {
    var quote = value && value[pair.key];
    if (!quote || quote.code !== pair.code || quote.codein !== "BRL") return null;
    var bid = Number(quote.bid);
    var percent = Number(quote.pctChange);
    var seconds = Number(quote.timestamp);
    if (!Number.isFinite(bid) || bid <= pair.low || bid >= pair.high ||
        !Number.isFinite(percent) || Math.abs(percent) >= 50 ||
        !Number.isInteger(seconds) || seconds <= 0) return null;
    return { pair: pair, bid: bid, change: percent, time: seconds * 1000 };
  }

  // Pairs that fail validation are left out; the list hides only when none is valid.
  function parse(value) {
    var quotes = pairs.map(function (pair) { return parseOne(value, pair); }).filter(Boolean);
    return quotes.length ? quotes : null;
  }

  function twoDigits(value) {
    return String(value).padStart(2, "0");
  }

  // pt-BR digits: dot for thousands, comma for decimals.
  function money(value, decimals) {
    var parts = value.toFixed(decimals).split(".");
    return "R$ " + parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ".") + (parts[1] ? "," + parts[1] : "");
  }

  function format(quote, now) {
    var at = new Date(quote.time);
    var today = new Date(now);
    var clock = twoDigits(at.getHours()) + ":" + twoDigits(at.getMinutes());
    var sameDay = at.getFullYear() === today.getFullYear() && at.getMonth() === today.getMonth() &&
      at.getDate() === today.getDate();
    var rounded = Math.round(quote.change * 100) / 100;
    return {
      name: quote.pair.name,
      price: money(quote.bid, quote.pair.decimals),
      change: (rounded > 0 ? "+" : rounded < 0 ? "−" : "") + Math.abs(rounded).toFixed(2).replace(".", ",") + "%",
      direction: rounded > 0 ? "up" : rounded < 0 ? "down" : "flat",
      time: sameDay ? clock : twoDigits(at.getDate()) + "/" + twoDigits(at.getMonth() + 1) + " " + clock
    };
  }

  function cell(row, className, text) {
    var node = document.createElement("span");
    node.className = className;
    node.textContent = text;
    row.appendChild(node);
  }

  function render() {
    var now = Date.now();
    var fresh = (lastQuotes || []).filter(function (quote) { return now - quote.time <= maxAge; });
    while (list.firstChild) list.removeChild(list.firstChild);
    container.hidden = fresh.length === 0;
    window.clearTimeout(expiryTimer);
    if (!fresh.length) return;
    fresh.forEach(function (quote) {
      var text = format(quote, now);
      var row = document.createElement("li");
      cell(row, "market-name", text.name);
      cell(row, "market-price", text.price);
      cell(row, "market-change " + text.direction, text.change);
      cell(row, "market-time", text.time);
      list.appendChild(row);
    });
    // Redraw when the oldest shown quote gets too old.
    var oldest = Math.min.apply(Math, fresh.map(function (quote) { return quote.time; }));
    expiryTimer = window.setTimeout(render, oldest + maxAge - now);
  }

  function request() {
    var controller = new window.AbortController();
    var timer = window.setTimeout(function () { controller.abort(); }, requestTimeout);
    return window.fetch(url, {
      signal: controller.signal,
      // The API allows serving a cached answer up to three days old while it revalidates,
      // which showed a stale quote after the TV was idle. Always ask the server.
      cache: "no-cache",
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
    if (busy || stopped) return Promise.resolve(lastQuotes);
    busy = true;
    window.clearTimeout(refreshTimer);
    // Keep the last good quotes when a request fails; render hides each one once it is too old.
    return request().then(parse).catch(function () { return null; }).then(function (quotes) {
      if (quotes) lastQuotes = quotes;
      if (!stopped) render();
      busy = false;
      schedule();
      return lastQuotes;
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
  if (!container || !list || typeof window.fetch !== "function" ||
      typeof window.AbortController !== "function") return;
  document.addEventListener("visibilitychange", visibilityChanged);
  refresh();
}());
