const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const source = fs.readFileSync(
  path.join(__dirname, "..", "layouts", "q65d-2123", "device.js"),
  "utf8"
);

function createDevice(options = {}) {
  const calls = [];
  const timers = new Map();
  let timerID = 0;
  let selectedSource = { type: "HDMI", number: 2 };
  const native = {
    ApplicationControlData: function (key, value) {
      this.key = key;
      this.value = Array.from(value);
    },
    ApplicationControl: function (operation, uri, mime, category, data) {
      Object.assign(this, { operation, uri, mime, category, data: Array.from(data) });
    },
    application: {
      launch(id, success, error) {
        calls.push({ method: "launch", id, success, error });
      },
      launchAppControl(control, id, success, error) {
        calls.push({ method: "launchAppControl", control, id, success, error });
      }
    },
    systeminfo: options.noSources ? undefined : {
      getPropertyValue(property, success, error) {
        calls.push({ method: "getPropertyValue", property, success, error });
      }
    },
    tvwindow: options.noSources ? undefined : {
      setSource(descriptor, success, error) {
        calls.push({ method: "setSource", descriptor, success, error });
      },
      getSource() {
        calls.push({ method: "getSource" });
        return selectedSource;
      }
    }
  };
  const window = {
    tizen: options.browser ? undefined : native,
    setTimeout(callback, delay) {
      const id = ++timerID;
      timers.set(id, { callback, delay });
      return id;
    },
    clearTimeout(id) { timers.delete(id); }
  };
  vm.runInNewContext(source, { window, console }, { filename: "device.js" });
  return {
    device: window.LauncherDevice,
    calls,
    timers,
    latest(method) { return calls.findLast(call => call.method === method); },
    select(descriptor) { selectedSource = descriptor; }
  };
}

test("app shortcuts launch the IDs read from the Q65D", async t => {
  for (const [id, app] of [
    ["youtube", "9Ur5IzDKqV.TizenYouTube"],
    ["stremio", "IkWsFHtOY9.Stremio"],
    ["spotify", "rJeHak5zRg.Spotify"]
  ]) {
    await t.test(id, async () => {
      const h = createDevice();
      const result = h.device.activate({ id, type: "app" });
      const call = h.latest("launch");
      assert.equal(call.id, app);
      assert.equal(h.calls.length, 1);
      call.success();
      await result;
      assert.equal(h.timers.size, 0);
    });
  }
});

test("a failed app launch reports the TV error and releases the action", async () => {
  const h = createDevice();
  const result = h.device.activate({ id: "stremio", type: "app" });
  h.latest("launch").error({ name: "NotFoundError" });
  await assert.rejects(result, /O app não abriu.*NotFoundError/);
  const next = h.device.activate({ id: "youtube", type: "app" });
  h.latest("launch").success();
  await next;
});

test("Settings keeps the native settings entry contract", async () => {
  const h = createDevice();
  const result = h.device.activate({ id: "settings", type: "settings" });
  const call = h.latest("launchAppControl");
  assert.equal(call.id, "org.tizen.menu");
  assert.deepEqual(
    Object.fromEntries(call.control.data.map(entry => [entry.key, entry.value])),
    {
      Entry: ["s/setting"],
      __K_EX_FORCE_BOOST: ["enable"],
      __K_SPLASH_SCREEN: ["LA_UI_VR_TRANSPARENT"],
      __K_EX_SPLASH_SCREEN_PROGRESS_BAR: ["false"]
    }
  );
  call.success();
  await result;
});

test("Back explicitly opens stock Home", async () => {
  const h = createDevice();
  const result = h.device.back();
  assert.equal(h.latest("launch").id, "com.samsung.tv.csfs");
  h.latest("launch").success();
  await result;
});

test("unknown, inherited and Frame-only actions are refused without native calls", async () => {
  const h = createDevice();
  for (const action of [
    null,
    { id: "constructor", type: "app" },
    { id: "netflix", type: "app" },
    { id: "apple-tv", type: "source", port: 1 },
    { id: "hdmi-2", type: "source", port: 1 },
    { id: "hdmi-3", type: "source", port: 3 },
    { id: "art-mode", type: "art" }
  ]) {
    await assert.rejects(h.device.activate(action), /não está disponível/);
  }
  assert.equal(h.calls.length, 0);
});

test("a second action waits for the first and a silent TV times out", async () => {
  const h = createDevice();
  const first = h.device.activate({ id: "youtube", type: "app" });
  await assert.rejects(h.device.activate({ id: "stremio", type: "app" }), /Aguarde/);
  const [id, timer] = h.timers.entries().next().value;
  assert.equal(timer.delay, 8000);
  h.timers.delete(id);
  timer.callback();
  await assert.rejects(first, /não confirmou/);
});

test("outside the TV the controls report that they are unavailable", async () => {
  const h = createDevice({ browser: true });
  assert.equal(h.device.available, false);
  await assert.rejects(h.device.activate({ id: "youtube", type: "app" }), /Abra este app na TV/);
});

test("inputs pass the TV's own HDMI descriptor, confirm it and open the viewer", async t => {
  for (const [id, port, list] of [["hdmi-2", 2, "connected"], ["hdmi-1", 1, "disconnected"]]) {
    await t.test(id, async () => {
      const h = createDevice();
      h.select({ type: "HDMI", number: port });
      const descriptor = { type: "HDMI", number: port, vendorField: "kept" };
      const result = h.device.activate({ id, type: "source", port });
      const inventory = { connected: [], disconnected: [] };
      inventory[list].push(descriptor);
      assert.equal(h.latest("getPropertyValue").property, "VIDEOSOURCE");
      h.latest("getPropertyValue").success(inventory);
      assert.equal(h.latest("setSource").descriptor, descriptor);
      h.latest("setSource").success();
      const viewer = h.latest("launch");
      assert.equal(viewer.id, "org.tizen.tv-viewer");
      viewer.success();
      await result;
    });
  }
});

test("an input the TV does not confirm or list is reported without opening the viewer", async () => {
  const missing = createDevice();
  const absent = missing.device.activate({ id: "hdmi-1", type: "source", port: 1 });
  missing.latest("getPropertyValue").success({ connected: [], disconnected: [] });
  await assert.rejects(absent, /HDMI 1 não está disponível/);

  const other = createDevice();
  other.select({ type: "HDMI", number: 1 });
  const wrong = other.device.activate({ id: "hdmi-2", type: "source", port: 2 });
  other.latest("getPropertyValue").success({ connected: [{ type: "HDMI", number: 2 }], disconnected: [] });
  other.latest("setSource").success();
  await assert.rejects(wrong, /não confirmou a entrada HDMI 2/);
  for (const h of [missing, other]) assert.equal(h.latest("launch"), undefined);

  const unsupported = createDevice({ noSources: true });
  await assert.rejects(
    unsupported.device.activate({ id: "hdmi-2", type: "source", port: 2 }),
    /não permite trocar de entrada/
  );
});

test("TV ao vivo selects the antenna source by type and opens the viewer", async () => {
  const h = createDevice();
  const antenna = { type: "TV", number: 0, vendorField: "kept" };
  h.select(antenna);
  const result = h.device.activate({ id: "tv", type: "source" });
  h.latest("getPropertyValue").success({ connected: [antenna], disconnected: [{ type: "HDMI", number: 1 }] });
  assert.equal(h.latest("setSource").descriptor, antenna);
  h.latest("setSource").success();
  h.latest("launch").success();
  await result;
  assert.equal(h.latest("launch").id, "org.tizen.tv-viewer");

  const none = createDevice();
  const missing = none.device.activate({ id: "tv", type: "source" });
  none.latest("getPropertyValue").success({ connected: [{ type: "HDMI", number: 2 }], disconnected: [] });
  await assert.rejects(missing, /TV ao vivo não está disponível/);
  await assert.rejects(none.device.activate({ id: "tv", type: "source", port: 1 }), /não está disponível/);
});
