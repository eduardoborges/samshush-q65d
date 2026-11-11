/* Latest headlines from the public g1 RSS feed: https://g1.globo.com/rss/g1/
   Each headline is a tile that opens its article in the TV browser. Feed text is written with
   textContent only, so feed markup can never reach the page. */
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
  var drawn = "";

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

  // Only https g1 pages become tiles; device.js checks the same before opening one.
  function article(value) {
    if (value.length > 2048) return false;
    try {
      var url = new URL(value);
      return url.protocol === "https:" && url.hostname === "g1.globo.com" && !url.username && !url.password;
    } catch (error) {
      return false;
    }
  }

  function parse(text) {
    if (typeof text !== "string" || text.length > maxLength || text.indexOf("<rss") < 0) return null;
    var headlines = [];
    var items = /<item\b[^>]*>([\s\S]*?)<\/item>/g;
    var match;
    while ((match = items.exec(text)) && headlines.length < shown) {
      var title = /<title>([\s\S]*?)<\/title>/.exec(match[1]);
      var date = /<pubDate>([\s\S]*?)<\/pubDate>/.exec(match[1]);
      var link = /<link>([\s\S]*?)<\/link>/.exec(match[1]);
      var headline = title ? decode(title[1]) : "";
      var time = date ? Date.parse(decode(date[1])) : NaN;
      var url = link ? decode(link[1]) : "";
      if (!headline || automated.test(headline) || !Number.isFinite(time) || !article(url)) continue;
      headlines.push({ title: headline.slice(0, 200), time: time, url: url });
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

  function cell(parent, className, text) {
    var node = document.createElement("span");
    node.className = className;
    node.textContent = text;
    parent.appendChild(node);
  }

  function tile(headline, index, now) {
    var button = document.createElement("button");
    button.className = "tile news-tile";
    button.type = "button";
    button.tabIndex = -1;
    button.dataset.id = "news-" + index;
    button.dataset.url = headline.url;
    button.setAttribute("aria-label", headline.title);
    cell(button, "news-time", when(headline.time, now));
    cell(button, "news-title", headline.title);
    return button;
  }

  // The tiles are rebuilt only when the headlines change, so a refresh never moves the focus
  // off a headline that is still there.
  function render() {
    var now = Date.now();
    var fresh = lastNews && now - lastNews.fetched <= maxAge;
    var shown = fresh ? JSON.stringify(lastNews.headlines.map(function (headline) {
      return [headline.url, headline.title, when(headline.time, now)];
    })) : "";
    window.clearTimeout(expiryTimer);
    if (shown !== drawn) {
      drawn = shown;
      while (list.firstChild) list.removeChild(list.firstChild);
      if (fresh) {
        lastNews.headlines.forEach(function (headline, index) { list.appendChild(tile(headline, index, now)); });
      }
      container.hidden = !fresh;
      if (window.LauncherUI && typeof window.LauncherUI.refresh === "function") window.LauncherUI.refresh();
    }
    if (fresh) expiryTimer = window.setTimeout(render, lastNews.fetched + maxAge - now);
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
