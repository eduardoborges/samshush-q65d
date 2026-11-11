(function () {
  "use strict";

  var actions = {
    "youtube": { id: "youtube", type: "app" },
    "stremio": { id: "stremio", type: "app" },
    "primevideo": { id: "primevideo", type: "app" },
    "tvplus": { id: "tvplus", type: "app" },
    "spotify": { id: "spotify", type: "app" },
    "settings": { id: "settings", type: "settings" },
    "tv": { id: "tv", type: "source" },
    "hdmi-2": { id: "hdmi-2", type: "source", port: 2 },
    "hdmi-1": { id: "hdmi-1", type: "source", port: 1 }
  };
  // One row per visible .tiles container, in page order. Up and Down move between rows and return
  // to the column used last. The headline row stays hidden until its feed loads, so a module that
  // shows or hides a row calls refresh() and the rows are collected again.
  var rows = [];
  var lastColumn = new WeakMap();
  // Tiles that drive a module on this page instead of the TV, such as the headline buttons.
  var controls = new Map();
  var title = document.getElementById("selection-title");
  var error = document.getElementById("action-error");
  var clock = document.getElementById("clock");
  var date = document.getElementById("date");
  var weekdays = ["domingo", "segunda-feira", "terça-feira", "quarta-feira", "quinta-feira",
    "sexta-feira", "sábado"];
  var months = ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto",
    "setembro", "outubro", "novembro", "dezembro"];
  var adapter = window.LauncherDevice;
  var current = { row: 0, column: 0 };
  var busy = false;
  // After ten minutes without a key press the gradient fades to black to save power.
  var restDelay = 10 * 60 * 1000;
  var restTimer = null;

  function collect() {
    rows = Array.prototype.slice.call(document.querySelectorAll(".tiles")).filter(function (shelf) {
      return !shelf.closest("[hidden]");
    }).map(function (shelf) {
      return { shelf: shelf, tiles: Array.prototype.slice.call(shelf.querySelectorAll(".tile:not(:disabled)")) };
    }).filter(function (row) { return row.tiles.length > 0; });
  }

  function allTiles() {
    return rows.reduce(function (all, row) { return all.concat(row.tiles); }, []);
  }

  function actionFor(tile) {
    if (tile.dataset.url) return { id: "news", type: "link", url: tile.dataset.url };
    return Object.assign({}, actions[tile.dataset.id]);
  }

  function selectedTile() {
    return rows[current.row].tiles[current.column];
  }

  function reportError(reason) {
    error.textContent = reason && reason.message ? reason.message : "Esta ação não está disponível.";
    error.hidden = false;
  }

  function notify(name, value) {
    if (typeof api[name] === "function") {
      try { api[name](value); } catch (reason) { console.error(reason); }
    }
  }

  function select(row, column, focus) {
    if (row < 0 || row >= rows.length) return false;
    column = Math.max(0, Math.min(rows[row].tiles.length - 1, column));
    current = { row: row, column: column };
    lastColumn.set(rows[row].shelf, column);
    var chosen = selectedTile();
    allTiles().forEach(function (tile) {
      tile.classList.toggle("selected", tile === chosen);
      tile.tabIndex = tile === chosen ? 0 : -1;
    });
    title.textContent = chosen.getAttribute("aria-label");
    error.hidden = true;
    error.textContent = "";
    if (focus) chosen.focus();
    notify("onSelection", actionFor(chosen));
    return true;
  }

  // A row may name the tile it starts on, like the next button under the headlines.
  function columnFor(row) {
    var shelf = rows[row].shelf;
    return lastColumn.has(shelf) ? lastColumn.get(shelf) : Number(shelf.dataset.start) || 0;
  }

  function move(step) {
    var row = current.row + step;
    if (row >= 0 && row < rows.length) select(row, columnFor(row), true);
  }

  function locate(tile) {
    for (var row = 0; row < rows.length; row += 1) {
      var column = rows[row].tiles.indexOf(tile);
      if (column >= 0) return { row: row, column: column };
    }
    return null;
  }

  function selectId(id, focus) {
    var place = locate(allTiles().filter(function (tile) { return tile.dataset.id === id; })[0]);
    return place ? select(place.row, place.column, focus) : false;
  }

  // Keeps the selection on the same tile while it is still shown, and moves it to YouTube when its
  // row is hidden.
  function refresh() {
    var tile = rows[current.row] && rows[current.row].tiles[current.column];
    collect();
    var place = tile && locate(tile);
    if (place) {
      current = place;
      return;
    }
    // A hidden tile keeps its classes, so it would come back looking selected.
    if (tile) {
      tile.classList.remove("selected");
      tile.tabIndex = -1;
    }
    if (!selectId("youtube", true)) select(0, 0, true);
  }

  function perform(method, action) {
    if (busy) return;
    error.hidden = true;
    if (!adapter || typeof adapter[method] !== "function") {
      reportError(new Error("Sem conexão com a TV."));
      return;
    }
    busy = true;
    var tile = selectedTile();
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
    var tile = selectedTile();
    var control = controls.get(tile.dataset.id);
    if (control) control();
    else perform("activate", actionFor(tile));
  }

  // Runs every second but touches the page only when the minute changes.
  function updateClock() {
    var now = new Date();
    var time = String(now.getHours()).padStart(2, "0") + ":" + String(now.getMinutes()).padStart(2, "0");
    var weekday = weekdays[now.getDay()];
    var day = weekday.charAt(0).toUpperCase() + weekday.slice(1) + ", " +
      now.getDate() + " de " + months[now.getMonth()];
    if (clock.textContent === time && date.textContent === day) return;
    now.setSeconds(0, 0);
    clock.dateTime = now.toISOString();
    clock.textContent = time;
    date.textContent = day;
  }

  function rest() {
    document.body.classList.add("resting");
  }

  // Restarts the ten minutes and says whether the screen was resting, so the key that brings the
  // gradient back does nothing else.
  function wake() {
    var resting = document.body.classList.contains("resting");
    document.body.classList.remove("resting");
    window.clearTimeout(restTimer);
    restTimer = window.setTimeout(rest, restDelay);
    return resting;
  }

  var api = {
    onSelection: null,
    onAction: null,
    setAdapter: function (next) {
      adapter = next;
      document.title = adapter && adapter.available === true ? "Home" : "Home — preview";
    },
    select: function (id) { return selectId(id, true); },
    refresh: refresh,
    setControl: function (id, handler) { controls.set(id, handler); },
    getSelection: function () { return actionFor(selectedTile()); }
  };
  window.LauncherUI = api;

  // Delegated, so tiles added later by modules behave like the ones in the page.
  document.addEventListener("focusin", function (event) {
    var tile = event.target.closest && event.target.closest(".tile");
    var place = tile && locate(tile);
    if (place && !tile.classList.contains("selected")) select(place.row, place.column, false);
  });
  document.addEventListener("click", function (event) {
    var tile = event.target.closest && event.target.closest(".tile");
    var place = tile && locate(tile);
    if (!place) return;
    select(place.row, place.column, false);
    activate();
  });

  document.addEventListener("keydown", function (event) {
    var key = event.key;
    var code = event.keyCode;
    if (wake()) {
      event.preventDefault();
    } else if (key === "ArrowLeft" || code === 37) {
      event.preventDefault();
      select(current.row, current.column - 1, true);
    } else if (key === "ArrowRight" || code === 39) {
      event.preventDefault();
      select(current.row, current.column + 1, true);
    } else if (key === "ArrowUp" || code === 38) {
      event.preventDefault();
      move(-1);
    } else if (key === "ArrowDown" || code === 40) {
      event.preventDefault();
      move(1);
    } else if (key === "Enter" || code === 13) {
      event.preventDefault();
      if (!event.repeat) activate();
    } else if (key === "Escape" || key === "Backspace" || key === "BrowserBack" || code === 10009) {
      event.preventDefault();
      if (!event.repeat) perform("back", null);
    }
  });

  document.addEventListener("visibilitychange", function () {
    if (document.hidden) {
      window.clearTimeout(restTimer);
      return;
    }
    wake();
    updateClock();
    select(current.row, current.column, true);
  });

  api.setAdapter(adapter);
  updateClock();
  window.setInterval(updateClock, 1000);
  wake();
  collect();
  if (!selectId("youtube", true)) select(0, 0, true);
}());
