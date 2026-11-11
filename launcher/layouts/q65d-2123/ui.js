(function () {
  "use strict";

  var actions = {
    "youtube": { id: "youtube", type: "app" },
    "stremio": { id: "stremio", type: "app" },
    "spotify": { id: "spotify", type: "app" },
    "settings": { id: "settings", type: "settings" },
    "hdmi-2": { id: "hdmi-2", type: "source", port: 2 },
    "hdmi-1": { id: "hdmi-1", type: "source", port: 1 }
  };
  // One row per shelf; Up and Down move between shelves and return to the column used last.
  var rows = Array.prototype.slice.call(document.querySelectorAll(".tiles")).map(function (shelf) {
    return Array.prototype.slice.call(shelf.querySelectorAll(".tile:not(:disabled)"));
  }).filter(function (row) { return row.length > 0; });
  var tiles = rows.reduce(function (all, row) { return all.concat(row); }, []);
  var lastColumn = rows.map(function () { return 0; });
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

  function actionFor(tile) {
    return Object.assign({}, actions[tile.dataset.id]);
  }

  function selectedTile() {
    return rows[current.row][current.column];
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
    column = Math.max(0, Math.min(rows[row].length - 1, column));
    current = { row: row, column: column };
    lastColumn[row] = column;
    var chosen = selectedTile();
    tiles.forEach(function (tile) {
      tile.classList.toggle("selected", tile === chosen);
      tile.tabIndex = tile === chosen ? 0 : -1;
    });
    title.textContent = chosen.querySelector(".tile-label").textContent;
    error.hidden = true;
    error.textContent = "";
    if (focus) chosen.focus();
    notify("onSelection", actionFor(chosen));
    return true;
  }

  function locate(tile) {
    for (var row = 0; row < rows.length; row += 1) {
      var column = rows[row].indexOf(tile);
      if (column >= 0) return { row: row, column: column };
    }
    return null;
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
    perform("activate", actionFor(selectedTile()));
  }

  function updateClock() {
    var now = new Date();
    var weekday = weekdays[now.getDay()];
    clock.dateTime = now.toISOString();
    clock.textContent = String(now.getHours()).padStart(2, "0") + ":" +
      String(now.getMinutes()).padStart(2, "0");
    date.textContent = weekday.charAt(0).toUpperCase() + weekday.slice(1) + ", " +
      now.getDate() + " de " + months[now.getMonth()];
  }

  var api = {
    onSelection: null,
    onAction: null,
    setAdapter: function (next) {
      adapter = next;
      document.title = adapter && adapter.available === true ? "Home" : "Home — preview";
    },
    select: function (id) {
      var place = locate(tiles.find(function (tile) { return tile.dataset.id === id; }));
      return place ? select(place.row, place.column, true) : false;
    },
    getSelection: function () { return actionFor(selectedTile()); }
  };
  window.LauncherUI = api;

  tiles.forEach(function (tile) {
    tile.addEventListener("focus", function () {
      var place = locate(tile);
      if (place && !tile.classList.contains("selected")) select(place.row, place.column, false);
    });
    tile.addEventListener("click", function () {
      var place = locate(tile);
      if (!place) return;
      select(place.row, place.column, false);
      activate();
    });
  });

  document.addEventListener("keydown", function (event) {
    var key = event.key;
    var code = event.keyCode;
    if (key === "ArrowLeft" || code === 37) {
      event.preventDefault();
      select(current.row, current.column - 1, true);
    } else if (key === "ArrowRight" || code === 39) {
      event.preventDefault();
      select(current.row, current.column + 1, true);
    } else if (key === "ArrowUp" || code === 38) {
      event.preventDefault();
      select(current.row - 1, lastColumn[current.row - 1], true);
    } else if (key === "ArrowDown" || code === 40) {
      event.preventDefault();
      select(current.row + 1, lastColumn[current.row + 1], true);
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
      select(current.row, current.column, true);
    }
  });

  api.setAdapter(adapter);
  updateClock();
  window.setInterval(updateClock, 1000);
  select(0, 0, true);
}());
