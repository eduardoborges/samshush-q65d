/* Headlines from the g1 home page, read from the JSON feed the page itself loads. The feed is not
   documented and may change without notice; the block then hides as after any failed request. It
   has 540×304 photos, where the public RSS feed links only the full-size originals.
   One headline shows at a time and the slides advance every 8 seconds, except while the focus is
   on the block. Feed text is written with textContent only, so feed markup can never reach the page. */
(function () {
  "use strict";

  var url = "https://falkor-cda.bastian.globo.com/tenants/g1/instances/" +
    "4af56893-1f9a-4504-9531-74458e481f91/posts/page/1";
  var refreshDelay = 30 * 60 * 1000;
  var requestTimeout = 20 * 1000;
  var maxAge = 6 * 60 * 60 * 1000;
  // The feed is about 130 KB; anything far larger is not the feed.
  var maxLength = 2 * 1024 * 1024;
  var shown = 6;
  var slideDelay = 8 * 1000;
  var container = document.getElementById("news");
  var slide = document.getElementById("news-slide");
  var track = document.getElementById("news-track");
  var dots = document.getElementById("news-dots");
  var refreshTimer = null;
  var expiryTimer = null;
  var slideTimer = null;
  var busy = false;
  var stopped = false;
  var lastNews = null;
  var drawn = "";
  var headlines = [];
  var position = 0;

  function text(value) {
    return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  }

  // Articles must be https g1 pages, which device.js checks again before opening one, and photos
  // must come from the g1 image server the page allows.
  function link(value, host) {
    if (typeof value !== "string" || value.length > 2048) return false;
    try {
      var parsed = new URL(value);
      return parsed.protocol === "https:" && parsed.hostname === host && !parsed.username && !parsed.password;
    } catch (error) {
      return false;
    }
  }

  // The top headline on the g1 home often has no photo. Headlines with a photo come first, and the
  // others fill any slides left over, in feed order.
  function parse(value) {
    var items = value && Array.isArray(value.items) ? value.items : [];
    var found = [];
    var seen = {};
    for (var index = 0; index < items.length; index += 1) {
      var item = items[index] || {};
      var content = item.content || {};
      var title = text(content.title);
      var time = typeof item.publication === "string" ? Date.parse(item.publication) : NaN;
      var sizes = content.image && content.image.sizes;
      var image = sizes && sizes.S && sizes.S.url;
      if (!title || !Number.isFinite(time) || !link(content.url, "g1.globo.com") || seen[content.url]) continue;
      seen[content.url] = true;
      found.push({
        title: title.slice(0, 200),
        section: text(content.section).slice(0, 40),
        time: time,
        url: content.url,
        image: link(image, "s2-g1.glbimg.com") ? image : ""
      });
    }
    var ordered = found.filter(function (headline) { return headline.image; })
      .concat(found.filter(function (headline) { return !headline.image; }))
      .slice(0, shown);
    return ordered.length ? ordered : null;
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

  function cell(parent, className, value) {
    var node = document.createElement("span");
    node.className = className;
    node.textContent = value;
    parent.appendChild(node);
  }

  function item(headline, now) {
    var node = document.createElement("span");
    node.className = "news-item";
    if (headline.image) {
      var image = document.createElement("img");
      image.className = "news-image";
      image.alt = "";
      image.decoding = "async";
      image.referrerPolicy = "no-referrer";
      // A photo that fails to load leaves the text on its own.
      image.addEventListener("error", function () { node.removeChild(image); });
      image.src = headline.image;
      node.appendChild(image);
    }
    var words = document.createElement("span");
    words.className = "news-text";
    cell(words, "news-meta", [headline.section, when(headline.time, now)].filter(Boolean).join(" · "));
    cell(words, "news-title", headline.title);
    node.appendChild(words);
    return node;
  }

  // Moves the track to one slide and points the slide button at its article.
  function show(index, jump) {
    var count = headlines.length;
    var next = (index + count) % count;
    // Wrapping from the last slide to the first would sweep across them all, so it jumps instead.
    track.classList.toggle("news-jump", jump || Math.abs(next - position) > 1);
    position = next;
    track.style.transform = "translateX(" + (-100 * position) + "%)";
    slide.dataset.url = headlines[position].url;
    slide.setAttribute("aria-label", headlines[position].title);
    Array.prototype.forEach.call(dots.children, function (dot, at) {
      dot.classList.toggle("current", at === position);
    });
  }

  function focused() {
    return container.contains(document.activeElement);
  }

  function scheduleSlide() {
    window.clearTimeout(slideTimer);
    if (!stopped && !document.hidden && headlines.length > 1) slideTimer = window.setTimeout(advance, slideDelay);
  }

  // Waits while the focus is on the block, so a headline never changes under the reader.
  function advance() {
    if (headlines.length > 1 && !focused()) show(position + 1, false);
    scheduleSlide();
  }

  function step(by) {
    if (headlines.length < 2) return;
    show(position + by, false);
    scheduleSlide();
  }

  // The slides are rebuilt only when the headlines change, and the one on screen stays there when
  // it is still in the feed.
  function render() {
    var now = Date.now();
    var fresh = lastNews && now - lastNews.fetched <= maxAge ? lastNews.headlines : [];
    var key = JSON.stringify(fresh.map(function (headline) {
      return [headline.url, headline.title, headline.section, headline.image, when(headline.time, now)];
    }));
    window.clearTimeout(expiryTimer);
    if (key !== drawn) {
      drawn = key;
      var onScreen = headlines[position] ? headlines[position].url : "";
      var wasHidden = container.hidden;
      headlines = fresh;
      while (track.firstChild) track.removeChild(track.firstChild);
      while (dots.firstChild) dots.removeChild(dots.firstChild);
      fresh.forEach(function (headline) {
        track.appendChild(item(headline, now));
        dots.appendChild(document.createElement("span"));
      });
      if (fresh.length) {
        show(Math.max(0, fresh.map(function (headline) { return headline.url; }).indexOf(onScreen)), true);
      }
      container.hidden = !fresh.length;
      if (container.hidden !== wasHidden && window.LauncherUI && typeof window.LauncherUI.refresh === "function") {
        window.LauncherUI.refresh();
      }
      scheduleSlide();
    }
    if (fresh.length) expiryTimer = window.setTimeout(render, lastNews.fetched + maxAge - now);
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
    }).then(function (body) {
      if (body.length > maxLength) throw new Error("News feed is too large");
      return JSON.parse(body);
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
    return request().then(parse).catch(function () { return null; }).then(function (found) {
      if (found) lastNews = { headlines: found, fetched: Date.now() };
      if (!stopped) render();
      busy = false;
      schedule();
      return lastNews;
    });
  }

  function visibilityChanged() {
    if (document.hidden) {
      window.clearTimeout(refreshTimer);
      window.clearTimeout(slideTimer);
      return;
    }
    scheduleSlide();
    refresh();
  }

  function stop() {
    stopped = true;
    window.clearTimeout(refreshTimer);
    window.clearTimeout(expiryTimer);
    window.clearTimeout(slideTimer);
    document.removeEventListener("visibilitychange", visibilityChanged);
  }

  window.LauncherNews = { parse: parse, refresh: refresh, step: step, stop: stop };
  if (!container || !slide || !track || !dots || typeof window.fetch !== "function" ||
      typeof window.AbortController !== "function") return;
  if (window.LauncherUI && typeof window.LauncherUI.setControl === "function") {
    window.LauncherUI.setControl("news-previous", function () { step(-1); });
    window.LauncherUI.setControl("news-next", function () { step(1); });
  }
  document.addEventListener("visibilitychange", visibilityChanged);
  refresh();
}());
