import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";

/** Test-only control of one native Settings renderer in an explicitly isolated profile. */
export async function connectNativeSettings({ root, profile, deadlineAt = Date.now() + 8_000 }) {
  function timeout() {
    const remaining = Math.min(8_000, deadlineAt - Date.now());
    if (remaining <= 0) throw new Error("Native settings deadline exceeded; inspect before repeating mutations.");
    return remaining;
  }
  const port = Number((await readFile(join(profile, "DevToolsActivePort"), "utf8")).split("\n")[0]);
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) throw new Error("Invalid isolated debugging port.");
  const origin = `http://127.0.0.1:${port}`;
  // This helper runs in Node, outside Obsidian; only the verified loopback endpoint is fetched.
  const response = await globalThis.fetch(`${origin}/json/list`, { signal: AbortSignal.timeout(timeout()), redirect: "error" });
  if (!response.ok) throw new Error("Could not inspect isolated debugging targets.");
  const targets = await response.json();
  if (!Array.isArray(targets)) throw new Error("Invalid isolated debugging target list.");
  function target(predicate, label) {
    const matches = targets.filter(item => item.type === "page" && predicate(item));
    if (matches.length !== 1) throw new Error(`Expected one isolated ${label} target.`);
    const value = matches[0];
    const socket = new URL(value.webSocketDebuggerUrl);
    if (socket.protocol !== "ws:" || socket.hostname !== "127.0.0.1" || socket.port !== String(port) || socket.username || socket.password) throw new Error("Debugging target escaped the isolated loopback endpoint.");
    return value;
  }
  const mainTarget = target(item => item.url === "app://obsidian.md/index.html", "main");
  const settingsTarget = target(item => item.url === "about:blank" && item.title.startsWith(`Settings - ${basename(root)} - Obsidian `), "settings");

  async function client(target) {
    const openTimeout = timeout();
    const socket = new WebSocket(target.webSocketDebuggerUrl);
    let id = 0;
    const pending = new Map();
    function rejectPending() {
      for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new Error("Isolated debugging target closed; inspect before repeating mutations.")); }
      pending.clear();
    }
    socket.addEventListener("close", rejectPending);
    socket.addEventListener("message", event => {
      let message;
      try { message = JSON.parse(event.data); }
      catch { socket.close(); rejectPending(); return; }
      const entry = pending.get(message.id);
      if (!entry) return;
      pending.delete(message.id); clearTimeout(entry.timer);
      if (message.error) entry.reject(new Error(JSON.stringify(message.error)));
      else entry.resolve(message.result);
    });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { socket.close(); reject(new Error("Isolated debugging connection timed out.")); }, openTimeout);
      socket.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
      socket.addEventListener("error", () => { clearTimeout(timer); socket.close(); reject(new Error("Isolated debugging connection failed.")); }, { once: true });
    });
    function request(method, params = {}) {
      return new Promise((resolve, reject) => {
        if (socket.readyState !== WebSocket.OPEN) { reject(new Error("Isolated debugging connection is closed.")); return; }
        const current = ++id;
        const timer = setTimeout(() => { pending.delete(current); reject(new Error(`${method} timed out; do not repeat mutations automatically.`)); }, timeout());
        pending.set(current, { resolve, reject, timer });
        try { socket.send(JSON.stringify({ id: current, method, params })); }
        catch (error) { clearTimeout(timer); pending.delete(current); reject(error); }
      });
    }
    async function evaluate(expression) {
      const result = await request("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true, timeout: timeout() });
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
      return result.result?.value;
    }
    return { request, evaluate, disconnect: () => { socket.close(); rejectPending(); } };
  }

  let main;
  let settings;
  const mainGuard = `if (require('@electron/remote').app.getPath('userData') !== ${JSON.stringify(profile)}) throw new Error('Smoke profile mismatch'); if (app.vault.adapter.getBasePath() !== ${JSON.stringify(root)}) throw new Error('Smoke vault mismatch');`;
  async function verifyMain() { await main.evaluate(`(() => { ${mainGuard} return true; })()`); }
  async function evaluate(body) {
    await verifyMain();
    return settings.evaluate(`(() => { if (document.title !== ${JSON.stringify(settingsTarget.title)}) throw new Error('Smoke settings target mismatch'); const doc = document; ${body} })()`);
  }
  try {
    main = await client(mainTarget);
    await verifyMain();
    settings = await client(settingsTarget);
    await evaluate("return true;");
    return {
      evaluate,
      async screenshot() {
        await evaluate("return true;");
        const result = await settings.request("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
        if (typeof result.data !== "string") throw new Error("Native settings screenshot was empty.");
        return result.data;
      },
      async closeWindow() {
        await main.evaluate(`(() => { ${mainGuard} const remote = require('@electron/remote'); const windows = remote.BrowserWindow.getAllWindows().filter(window => window.getTitle() === ${JSON.stringify(settingsTarget.title)} && window.webContents.getURL() === 'about:blank'); if (windows.length !== 1) throw new Error('Expected one owned settings window'); windows[0].close(); remote.getCurrentWindow().focus(); return true; })()`);
      },
      disconnect() { settings.disconnect(); main.disconnect(); },
    };
  } catch (error) { settings?.disconnect(); main?.disconnect(); throw error; }
}
