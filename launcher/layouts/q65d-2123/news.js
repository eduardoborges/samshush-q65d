/* Latest headlines from the public g1 RSS feed: https://g1.globo.com/rss/g1/
   Headlines are written with textContent only, so feed markup can never reach the page. */
(function () {
  "use strict";

  var url = "https://g1.globo.com/rss/g1/";
  var refreshDelay = 30 * 60 * 1000;
  var requestTimeout = 20 * 1000;
  var maxAge = 6 * 60 * 60 * 1000;
  // The feed is about 400 KB; anything far larger is not the feed.
  var maxLength = 2 * 1024 * 1024;
  var shown = 4;
  // At night the feed fills with automated city forecasts, which the forecast panel already covers.
  var automated = /^Previsão do tempo hoje para /;
  var entities = { quot: "\"", apos: "'", lt: "<", gt: ">", amp: "&" };
  var container = document.getElementById("news");
  var list = document.getElementById("news-list");
  var refreshTimer = null;
  var expiryTimer = null;
  var busy = false;
  var stopped = false;
  var lastNews = null;

  function character(code, original) {
    try { return String.fromCodePoint(code); } catch (error) { return original; }
  }

  // Plain text from an RSS field: CDATA unwrapped, entities decoded in one pass, spaces collapsed.
  function decode(text) {
    return text.replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/, "$1")
      .replace(/&(#x[0-9a-f]+|#\d+|quot|apos|lt|gt|amp);/gi, function (match, name) {
        if (name[0] !== "#") return entities[name.toLowerCase()];
        return character(name[1].toLowerCase() === "x" ? parseInt(name.slice(2), 16) : Number(name.slice(1)), match);
      })
      .replace(/\s+/g, " ")
      .trim();
  }

  function parse(text) {
    if (typeof text !== "string" || text.length > maxLength || text.indexOf("<rss") < 0) return null;
    var headlines = [];
    var items = /<item\b[^>]*>([\s\S]*?)<\/item>/g;
    var match;
    while ((match = items.exec(text)) && headlines.length < shown) {
      var title = /<title>([\s\S]*?)<\/title>/.exec(match[1]);
      var date = /<pubDate>([\s\S]*?)<\/pubDate>/.exec(match[1]);
      var headline = title ? decode(title[1]) : "";
      var time = date ? Date.parse(decode(date[1])) : NaN;
      if (!headline || automated.test(headline) || !Number.isFinite(time)) continue;
      headlines.push({ title: headline.slice(0, 200), time: time });
    }
    return headlines.length ? headlines : null;
  }

  function twoDigits(value) {
    return String(value).padStart(2, "0");
  }

  function when(time, now) {
    var at = new Date(time);
    var today = new Date(now);
    var sameDay = at.getFullYear() === today.getFullYear() && at.getMonth() === today.getMonth() &&
      at.getDate() === today.getDate();
    return sameDay
      ? twoDigits(at.getHours()) + ":" + twoDigits(at.getMinutes())
      : twoDigits(at.getDate()) + "/" + twoDigits(at.getMonth() + 1);
  }

  function cell(row, className, text) {
    var node = document.createElement("span");
    node.className = className;
    node.textContent = text;
    row.appendChild(node);
  }

  function render() {
    var now = Date.now();
    var fresh = lastNews && now - lastNews.fetched <= maxAge;
    while (list.firstChild) list.removeChild(list.firstChild);
    container.hidden = !fresh;
    window.clearTimeout(expiryTimer);
    if (!fresh) return;
    lastNews.headlines.forEach(function (headline) {
      var row = document.createElement("li");
      cell(row, "news-time", when(headline.time, now));
      cell(row, "news-title", headline.title);
      list.appendChild(row);
    });
    expiryTimer = window.setTimeout(render, lastNews.fetched + maxAge - now);
  }

  function request() {
    var controller = new window.AbortController();
    var timer = window.setTimeout(function () { controller.abort(); }, requestTimeout);
    return window.fetch(url, {
      signal: controller.signal,
      credentials: "omit",
      referrerPolicy: "no-referrer"
    }).then(function (response) {
      if (!response.ok) throw new Error("News request failed");
      return response.text();
    }).finally(function () { window.clearTimeout(timer); });
  }

  function schedule() {
    window.clearTimeout(refreshTimer);
    if (!stopped && !document.hidden) refreshTimer = window.setTimeout(refresh, refreshDelay);
  }

  function refresh() {
    if (busy || stopped) return Promise.resolve(lastNews);
    busy = true;
    window.clearTimeout(refreshTimer);
    // Keep the last headlines when a request fails; render hides them once they are too old.
    return request().then(parse).catch(function () { return null; }).then(function (headlines) {
      if (headlines) lastNews = { headlines: headlines, fetched: Date.now() };
      if (!stopped) render();
      busy = false;
      schedule();
      return lastNews;
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

  window.LauncherNews = { parse: parse, refresh: refresh, stop: stop };
  if (!container || !list || typeof window.fetch !== "function" ||
      typeof window.AbortController !== "function") return;
  document.addEventListener("visibilitychange", visibilityChanged);
  refresh();
}());
