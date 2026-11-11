/* Q65D layout: public Tizen app launches and HDMI input selection. */
(function () {
  "use strict";

  var native = window.tizen;
  var available = Boolean(native && native.application);
  var inFlight = false;
  var operation = "http://tizen.org/appcontrol/operation/default";
  // App IDs come from this TV's package database. Settings and Back use the same
  // native contracts as the Frame launcher.
  var apps = {
    youtube: "9Ur5IzDKqV.TizenYouTube",
    stremio: "IkWsFHtOY9.Stremio",
    spotify: "rJeHak5zRg.Spotify"
  };
  var sources = { "hdmi-1": 1, "hdmi-2": 2 };

  function failure(error, message) {
    var detail = error && error.name;
    return new Error(message + (detail ? " (" + detail + ")" : ""));
  }

  function run(work) {
    if (!available) return Promise.reject(new Error("Abra este app na TV para usar os atalhos."));
    if (inFlight) return Promise.reject(new Error("Aguarde a ação anterior terminar."));
    inFlight = true;
    return new Promise(function (resolve, reject) {
      var finished = false;
      var timer = window.setTimeout(function () {
        finish(new Error("A TV não confirmou a ação. Confira a tela antes de tentar de novo."));
      }, 8000);
      function finish(error) {
        if (finished) return;
        finished = true;
        inFlight = false;
        window.clearTimeout(timer);
        if (error) reject(error); else resolve();
      }
      function active() { return !finished; }
      try { work(finish, active); } catch (error) { finish(failure(error, "A TV não conseguiu abrir esta tela.")); }
    });
  }

  function launchControl(id, entries, finish) {
    var data = Object.keys(entries).map(function (key) {
      return new native.ApplicationControlData(key, [entries[key]]);
    });
    var control = new native.ApplicationControl(operation, null, null, null, data);
    native.application.launchAppControl(control, id, function () { finish(); }, function (error) {
      finish(failure(error, "A TV não conseguiu abrir esta tela."));
    });
  }

  function launchApp(id, finish) {
    native.application.launch(id, function () { finish(); }, function (error) {
      finish(failure(error, "O app não abriu. Confira se ele ainda está instalado."));
    });
  }

  // Same contract as the Frame launcher: pass the TV's own descriptor, confirm it, then show the viewer.
  function selectSource(port, finish, active) {
    if (!native.systeminfo || !native.tvwindow) {
      finish(new Error("Esta TV não permite trocar de entrada por aqui."));
      return;
    }
    native.systeminfo.getPropertyValue("VIDEOSOURCE", function (video) {
      if (!active()) return;
      try {
        if (!video || !Array.isArray(video.connected) || !Array.isArray(video.disconnected)) {
          throw new Error("Invalid source inventory");
        }
        var matches = video.connected.concat(video.disconnected).filter(function (source) {
          return source && source.type === "HDMI" && source.number === port;
        });
        if (matches.length !== 1) {
          finish(new Error("HDMI " + port + " não está disponível. Confira o cabo."));
          return;
        }
        native.tvwindow.setSource(matches[0], function () {
          if (!active()) return;
          try {
            var selected = native.tvwindow.getSource();
            if (!selected || selected.type !== "HDMI" || selected.number !== port) {
              finish(new Error("A TV não confirmou a HDMI " + port + "."));
              return;
            }
            native.application.launch("org.tizen.tv-viewer", function () { finish(); }, function (error) {
              finish(failure(error, "A HDMI " + port + " foi selecionada, mas a TV não abriu a imagem."));
            });
          } catch (error) { finish(failure(error, "A troca de entrada não foi confirmada.")); }
        }, function (error) {
          if (active()) finish(failure(error, "A TV não conseguiu trocar de entrada."));
        });
      } catch (error) { finish(failure(error, "A TV não conseguiu ler as entradas HDMI.")); }
    }, function (error) {
      if (active()) finish(failure(error, "A TV não conseguiu ler as entradas HDMI."));
    });
  }

  function activate(action) {
    if (!action || !(
      (action.type === "app" && Object.prototype.hasOwnProperty.call(apps, action.id)) ||
      (action.type === "source" && Object.prototype.hasOwnProperty.call(sources, action.id) &&
        action.port === sources[action.id]) ||
      (action.id === "settings" && action.type === "settings")
    )) return Promise.reject(new Error("Este atalho não está disponível."));
    return run(function (finish, active) {
      if (action.type === "app") {
        launchApp(apps[action.id], finish);
      } else if (action.type === "source") {
        selectSource(action.port, finish, active);
      } else {
        launchControl("org.tizen.menu", {
          Entry: "s/setting",
          __K_EX_FORCE_BOOST: "enable",
          __K_SPLASH_SCREEN: "LA_UI_VR_TRANSPARENT",
          __K_EX_SPLASH_SCREEN_PROGRESS_BAR: "false"
        }, finish);
      }
    });
  }

  function back() {
    return run(function (finish) {
      // Explicit stock Home access remains available independently of the assigned default.
      native.application.launch("com.samsung.tv.csfs", function () { finish(); }, function (error) {
        finish(failure(error, "A Home da Samsung não abriu."));
      });
    });
  }

  window.LauncherDevice = {
    available: available,
    activate: activate,
    back: back
  };
}());
