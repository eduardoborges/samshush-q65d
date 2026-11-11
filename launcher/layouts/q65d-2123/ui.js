(function () {
  "use strict";

  var actions = {
    "youtube": { id: "youtube", type: "app" },
    "stremio": { id: "stremio", type: "app" },
    "settings": { id: "settings", type: "settings" }
  };
  var tiles = Array.prototype.slice.call(document.querySelectorAll(".tile:not(:disabled)"));
  var title = document.getElementById("selection-title");
  var error = document.getElementById("action-error");
  var clock = document.getElementById("clock");
  var adapter = window.LauncherDevice;
  var selected = 0;
  var busy = false;

  function actionFor(tile) {
    var action = actions[tile.dataset.id];
    return Object.assign({}, action);
  }

  function reportError(reason) {
    error.textContent = reason && reason.message ? reason.message : "This action is unavailable.";
    error.hidden = false;
  }

  function notify(name, value) {
    if (typeof api[name] === "function") {
      try { api[name](value); } catch (reason) { console.error(reason); }
    }
  }

  function select(index, focus) {
    if (index < 0 || index >= tiles.length) return false;
    selected = index;
    tiles.forEach(function (tile, position) {
      tile.classList.toggle("selected", position === selected);
      tile.tabIndex = position === selected ? 0 : -1;
    });
    title.textContent = tiles[selected].querySelector(".tile-label").textContent;
    error.hidden = true;
    error.textContent = "";
    if (focus) tiles[selected].focus();
    notify("onSelection", actionFor(tiles[selected]));
    return true;
  }

  function perform(method, action) {
    if (busy) return;
    error.hidden = true;
    if (!adapter || typeof adapter[method] !== "function") {
      reportError(new Error("No TV connection."));
      return;
    }
    busy = true;
    var tile = tiles[selected];
    tile.classList.add("pending");
    tile.setAttribute("aria-busy", "true");
    Promise.resolve().then(function () {
      return adapter[method](action);
    }).then(function (result) {
      notify("onAction", { action: action, method: method, result: result, error: null });
    }, function (reason) {
      reportError(reason);
      notify("onAction", { action: action, method: method, error: reason });
    }).then(function () {
      busy = false;
      tile.classList.remove("pending");
      tile.removeAttribute("aria-busy");
    });
  }

  function activate() {
    perform("activate", actionFor(tiles[selected]));
  }

  function updateClock() {
    var now = new Date();
    clock.dateTime = now.toISOString();
    clock.textContent = String(now.getHours()).padStart(2, "0") + ":" +
      String(now.getMinutes()).padStart(2, "0");
  }

  var api = {
    onSelection: null,
    onAction: null,
    setAdapter: function (next) {
      adapter = next;
      document.title = adapter && adapter.available === true ? "Home" : "Home — preview";
    },
    select: function (id) {
      return select(tiles.findIndex(function (tile) { return tile.dataset.id === id; }), true);
    },
    getSelection: function () { return actionFor(tiles[selected]); }
  };
  window.LauncherUI = api;

  tiles.forEach(function (tile, index) {
    tile.addEventListener("focus", function () {
      if (!tile.classList.contains("selected")) select(index, false);
    });
    tile.addEventListener("click", function () {
      select(index, false);
      activate();
    });
  });

  document.addEventListener("keydown", function (event) {
    var key = event.key;
    var code = event.keyCode;
    if (key === "ArrowLeft" || code === 37) {
      event.preventDefault();
      select(Math.max(0, selected - 1), true);
    } else if (key === "ArrowRight" || code === 39) {
      event.preventDefault();
      select(Math.min(tiles.length - 1, selected + 1), true);
    } else if (key === "Enter" || code === 13) {
      event.preventDefault();
      if (!event.repeat) activate();
    } else if (key === "Escape" || key === "Backspace" || key === "BrowserBack" || code === 10009) {
      event.preventDefault();
      if (!event.repeat) perform("back", null);
    }
  });

  document.addEventListener("visibilitychange", function () {
    if (!document.hidden) {
      updateClock();
      select(selected, true);
    }
  });

  api.setAdapter(adapter);
  updateClock();
  window.setInterval(updateClock, 1000);
  select(0, true);
}());
