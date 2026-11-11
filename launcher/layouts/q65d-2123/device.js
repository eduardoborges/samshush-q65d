/* Q65D layout: public Tizen app launches, input selection (antenna TV and HDMI) and g1 articles in the browser. */
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
  var browser = "org.tizen.browser";
  var view = "http://tizen.org/appcontrol/operation/view";
  var sources = {
    "tv": { type: "TV", name: "TV ao vivo" },
    "hdmi-2": { type: "HDMI", number: 2, name: "HDMI 2" },
    "hdmi-1": { type: "HDMI", number: 1, name: "HDMI 1" }
  };

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

  // Only https pages on g1 open. The address comes from the feed, so anything else is refused.
  function article(value) {
    if (typeof value !== "string" || value.length > 2048) return false;
    try {
      var url = new URL(value);
      return url.protocol === "https:" && url.hostname === "g1.globo.com" && !url.username && !url.password;
    } catch (error) {
      return false;
    }
  }

  function openArticle(url, finish) {
    var control = new native.ApplicationControl(view, url, null, null, null);
    native.application.launchAppControl(control, browser, function () { finish(); }, function (error) {
      finish(failure(error, "O navegador não abriu a notícia."));
    });
  }

  function launchApp(id, finish) {
    native.application.launch(id, function () { finish(); }, function (error) {
      finish(failure(error, "O app não abriu. Confira se ele ainda está instalado."));
    });
  }

  // Same contract as the Frame launcher: pass the TV's own descriptor, confirm it, then show the viewer.
  function sameSource(source, target) {
    return Boolean(source) && source.type === target.type &&
      (target.number === undefined || source.number === target.number);
  }

  function selectSource(target, finish, active) {
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
          return sameSource(source, target);
        });
        if (matches.length !== 1) {
          finish(new Error(target.name + " não está disponível nesta TV."));
          return;
        }
        native.tvwindow.setSource(matches[0], function () {
          if (!active()) return;
          try {
            var selected = native.tvwindow.getSource();
            if (!sameSource(selected, matches[0])) {
              finish(new Error("A TV não confirmou a entrada " + target.name + "."));
              return;
            }
            native.application.launch("org.tizen.tv-viewer", function () { finish(); }, function (error) {
              finish(failure(error, target.name + " foi selecionada, mas a TV não abriu a imagem."));
            });
          } catch (error) { finish(failure(error, "A troca de entrada não foi confirmada.")); }
        }, function (error) {
          if (active()) finish(failure(error, "A TV não conseguiu trocar de entrada."));
        });
      } catch (error) { finish(failure(error, "A TV não conseguiu ler as entradas.")); }
    }, function (error) {
      if (active()) finish(failure(error, "A TV não conseguiu ler as entradas."));
    });
  }

  function activate(action) {
    if (!action || !(
      (action.type === "app" && Object.prototype.hasOwnProperty.call(apps, action.id)) ||
      (action.type === "source" && Object.prototype.hasOwnProperty.call(sources, action.id) &&
        action.port === sources[action.id].number) ||
      (action.id === "settings" && action.type === "settings") ||
      (action.id === "news" && action.type === "link" && article(action.url))
    )) return Promise.reject(new Error("Este atalho não está disponível."));
    return run(function (finish, active) {
      if (action.type === "app") {
        launchApp(apps[action.id], finish);
      } else if (action.type === "source") {
        selectSource(sources[action.id], finish, active);
      } else if (action.type === "link") {
        openArticle(action.url, finish);
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
