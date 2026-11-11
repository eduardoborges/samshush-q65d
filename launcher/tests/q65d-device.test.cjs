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
    latest(method) { return calls.findLast(call => call.method === method); }
  };
}

test("app shortcuts launch the IDs read from the Q65D", async t => {
  for (const [id, app] of [
    ["youtube", "9Ur5IzDKqV.TizenYouTube"],
    ["stremio", "IkWsFHtOY9.Stremio"]
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
  await assert.rejects(result, /could not open.*NotFoundError/);
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
    { id: "art-mode", type: "art" }
  ]) {
    await assert.rejects(h.device.activate(action), /unavailable/);
  }
  assert.equal(h.calls.length, 0);
});

test("a second action waits for the first and a silent TV times out", async () => {
  const h = createDevice();
  const first = h.device.activate({ id: "youtube", type: "app" });
  await assert.rejects(h.device.activate({ id: "stremio", type: "app" }), /already in progress/);
  const [id, timer] = h.timers.entries().next().value;
  assert.equal(timer.delay, 8000);
  h.timers.delete(id);
  timer.callback();
  await assert.rejects(first, /did not confirm/);
});

test("outside the TV the controls report that they are unavailable", async () => {
  const h = createDevice({ browser: true });
  assert.equal(h.device.available, false);
  await assert.rejects(h.device.activate({ id: "youtube", type: "app" }), /Open this app on the TV/);
});
