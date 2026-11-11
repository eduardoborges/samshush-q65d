/* Q65D layout: launches apps through the public Tizen API and never switches inputs. */
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
    stremio: "IkWsFHtOY9.Stremio"
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
      try { work(finish); } catch (error) { finish(failure(error, "A TV não conseguiu abrir esta tela.")); }
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

  function activate(action) {
    if (!action || !(
      (action.type === "app" && Object.prototype.hasOwnProperty.call(apps, action.id)) ||
      (action.id === "settings" && action.type === "settings")
    )) return Promise.reject(new Error("Este atalho não está disponível."));
    return run(function (finish) {
      if (action.type === "app") {
        launchApp(apps[action.id], finish);
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
