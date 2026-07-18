import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";


const targetUrl = process.argv[2];
const outputDir = path.resolve(process.argv[3] || "workbench-browser-artifacts");
if (!targetUrl) {
  console.error("Usage: node tests/browser_check.mjs <url> [artifact-directory]");
  process.exit(2);
}

function chromePath() {
  return [
    process.env.CHROME_PATH,
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
  ].filter(Boolean)[0];
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
  });
}

async function waitForJson(url, timeout = 15000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    try {
      const response = await fetch(url);
      if (response.ok) return response.json();
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

class CdpClient {
  constructor(url) { this.url = url; this.nextId = 1; this.pending = new Map(); this.listeners = new Map(); }
  async connect() {
    this.socket = new WebSocket(this.url);
    await new Promise((resolve, reject) => {
      this.socket.addEventListener("open", resolve, { once: true });
      this.socket.addEventListener("error", reject, { once: true });
    });
    this.socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.id) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(message.error.message));
        else pending.resolve(message.result);
      } else {
        for (const listener of this.listeners.get(message.method) || []) listener(message.params || {});
      }
    });
  }
  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }
  on(method, listener) {
    const listeners = this.listeners.get(method) || [];
    listeners.push(listener);
    this.listeners.set(method, listeners);
  }
  close() { this.socket?.close(); }
}

async function evaluate(client, expression, awaitPromise = false) {
  const result = await client.send("Runtime.evaluate", { expression, awaitPromise, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  return result.result.value;
}

async function waitForReady(client, timeout = 30000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const state = await evaluate(client, `({ status: document.body.dataset.status, message: document.querySelector('#errorMessage')?.textContent })`);
    if (state.status === "ready") return state;
    if (state.status === "error") throw new Error(state.message || "Workbench entered error state");
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
  throw new Error("Workbench did not finish loading");
}

async function key(client, value, code) {
  await client.send("Input.dispatchKeyEvent", { type: "keyDown", key: value, code });
  await client.send("Input.dispatchKeyEvent", { type: "keyUp", key: value, code });
  await new Promise((resolve) => setTimeout(resolve, 120));
}

async function capture(client, name) {
  const screenshot = await client.send("Page.captureScreenshot", { format: "png", fromSurface: true, captureBeyondViewport: false });
  await writeFile(path.join(outputDir, name), Buffer.from(screenshot.data, "base64"));
}

const port = await freePort();
const profile = await mkdtemp(path.join(os.tmpdir(), "model-workbench-chrome-"));
await mkdir(outputDir, { recursive: true });
const browser = spawn(chromePath(), [
  "--headless=new",
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${profile}`,
  "--no-first-run",
  "--no-default-browser-check",
  "--enable-webgl",
  "--ignore-gpu-blocklist",
  "--use-angle=swiftshader",
  "--window-size=1440,900",
  "about:blank",
], { stdio: "ignore" });
const browserExited = new Promise((resolve) => browser.once("exit", resolve));

let client;
try {
  await waitForJson(`http://127.0.0.1:${port}/json/version`);
  const targets = await waitForJson(`http://127.0.0.1:${port}/json/list`);
  const target = targets.find((item) => item.type === "page");
  client = new CdpClient(target.webSocketDebuggerUrl);
  await client.connect();
  const consoleIssues = [];
  const networkFailures = [];
  client.on("Runtime.exceptionThrown", (params) => consoleIssues.push(params.exceptionDetails?.exception?.description || params.exceptionDetails?.text || "Runtime exception"));
  client.on("Runtime.consoleAPICalled", (params) => {
    if (params.type === "error") consoleIssues.push(params.args.map((arg) => arg.description || arg.value).join(" "));
  });
  client.on("Log.entryAdded", (params) => { if (params.entry.level === "error") consoleIssues.push(params.entry.text); });
  client.on("Network.loadingFailed", (params) => { if (!params.canceled) networkFailures.push(params.errorText); });
  await Promise.all([client.send("Page.enable"), client.send("Runtime.enable"), client.send("Log.enable"), client.send("Network.enable")]);
  await client.send("Page.navigate", { url: `${targetUrl}${targetUrl.includes("?") ? "&" : "?"}reset=1` });
  await waitForReady(client);

  const report = {
    targetUrl,
    consoleIssues,
    networkFailures,
    states: [],
    modelCount: 0,
    modeToggle: false,
    centerReset: false,
    rotationReset: false,
    directDrag: false,
    multiSelection: false,
    capture: false,
  };

  for (const viewport of [
    { label: "desktop-compact", width: 1280, height: 720 },
    { label: "desktop-standard", width: 1440, height: 900 },
    { label: "desktop-wide", width: 1920, height: 1080 },
  ]) {
    await client.send("Emulation.setDeviceMetricsOverride", { width: viewport.width, height: viewport.height, deviceScaleFactor: 1, mobile: false });
    await new Promise((resolve) => setTimeout(resolve, 250));
    const state = await evaluate(client, `(() => {
      const boxes = ['.topbar','.object-panel','.inspector','.stage'].map((selector) => {
        const rect = document.querySelector(selector).getBoundingClientRect();
        return { selector, left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
      });
      return {
        viewport: { width: innerWidth, height: innerHeight },
        document: { width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight },
        canvas: { width: document.querySelector('canvas').width, height: document.querySelector('canvas').height },
        boxes,
        render: window.__MODEL_WORKBENCH__.renderer.info.render,
      };
    })()`);
    state.screenshot = `${viewport.label}.png`;
    report.states.push(state);
    await capture(client, state.screenshot);
  }

  report.modelCount = await evaluate(client, `window.__MODEL_WORKBENCH__.entries.length`);
  await key(client, "e", "KeyE");
  report.modeToggle = await evaluate(client, `window.__MODEL_WORKBENCH__.mode === 'rotate' && window.__MODEL_WORKBENCH__.transform.object != null`);
  await capture(client, "desktop-rotate.png");
  await evaluate(client, `window.__MODEL_WORKBENCH__.entries[0].root.position.set(1, 0.5, 0)`);
  await key(client, "f", "KeyF");
  report.centerReset = await evaluate(client, `window.__MODEL_WORKBENCH__.entries[0].root.position.length() < 0.001`);
  await evaluate(client, `window.__MODEL_WORKBENCH__.entries[0].root.rotation.set(0.4, 0.7, -0.2)`);
  await key(client, "g", "KeyG");
  report.rotationReset = await evaluate(client, `Math.abs(window.__MODEL_WORKBENCH__.entries[0].root.rotation.y - (-12 * Math.PI / 180)) < 0.001`);
  await evaluate(client, `window.__MODEL_WORKBENCH__.select(1)`);
  report.multiSelection = await evaluate(client, `window.__MODEL_WORKBENCH__.selectedIndex === 1`);
  await key(client, "e", "KeyE");

  const dragInfo = await evaluate(client, `(() => {
    const api = window.__MODEL_WORKBENCH__;
    const vector = api.entries[0].root.position.clone().project(api.camera);
    const rect = api.renderer.domElement.getBoundingClientRect();
    return { x: rect.left + (vector.x + 1) * rect.width / 2, y: rect.top + (1 - vector.y) * rect.height / 2, before: api.entries[0].root.position.toArray() };
  })()`);
  await client.send("Input.dispatchMouseEvent", { type: "mousePressed", x: dragInfo.x, y: dragInfo.y, button: "left", clickCount: 1 });
  await client.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: dragInfo.x + 90, y: dragInfo.y - 45, button: "left", buttons: 1 });
  await client.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: dragInfo.x + 90, y: dragInfo.y - 45, button: "left", clickCount: 1 });
  await new Promise((resolve) => setTimeout(resolve, 180));
  const positionAfterDrag = await evaluate(client, `window.__MODEL_WORKBENCH__.entries[0].root.position.toArray()`);
  report.directDrag = positionAfterDrag.some(
    (value, index) => Math.abs(value - dragInfo.before[index]) > 0.05,
  );

  await evaluate(client, `window.__MODEL_WORKBENCH__.captureComposition()`, true);
  await new Promise((resolve) => setTimeout(resolve, 300));
  report.capture = await evaluate(client, `(() => { const image = document.querySelector('#capturePreview'); return document.querySelector('#captureDialog').open && image.src.startsWith('data:image/png') && image.naturalWidth === 1920 && image.naturalHeight === 1080; })()`);
  await capture(client, "desktop-capture-preview.png");

  await writeFile(path.join(outputDir, "browser-report.json"), JSON.stringify(report, null, 2));
  const failures = [];
  if (consoleIssues.length) failures.push(`Console errors: ${consoleIssues.join(" | ")}`);
  if (networkFailures.length) failures.push(`Network failures: ${networkFailures.join(" | ")}`);
  if (report.modelCount !== 2) failures.push(`Expected 2 models, found ${report.modelCount}`);
  for (const keyName of ["modeToggle", "centerReset", "rotationReset", "directDrag", "multiSelection", "capture"]) {
    if (!report[keyName]) failures.push(`${keyName} failed`);
  }
  for (const state of report.states) {
    if (!state.render?.triangles) failures.push(`${state.screenshot}: renderer reported zero triangles`);
    if (state.document.width > state.viewport.width + 1 || state.document.height > state.viewport.height + 1) failures.push(`${state.screenshot}: document overflow`);
    for (const box of state.boxes) {
      if (box.left < -2 || box.top < -2 || box.right > state.viewport.width + 2 || box.bottom > state.viewport.height + 2) failures.push(`${state.screenshot}: ${box.selector} exits viewport`);
    }
  }
  if (failures.length) {
    console.error(failures.join("\n"));
    process.exitCode = 1;
  } else {
    console.log(`Workbench browser verification passed. Report: ${path.join(outputDir, "browser-report.json")}`);
  }
} catch (error) {
  console.error(error.stack || error.message);
  process.exitCode = 1;
} finally {
  client?.close();
  browser.kill();
  await Promise.race([browserExited, new Promise((resolve) => setTimeout(resolve, 3000))]);
  await rm(profile, { recursive: true, force: true }).catch(() => {});
}
