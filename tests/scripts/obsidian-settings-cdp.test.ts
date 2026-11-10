import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { connectNativeSettings } from "../../scripts/obsidian-settings-cdp.mjs";
const parents: string[] = [];
function setup() {
  const profile = mkdtempSync(join(realpathSync(tmpdir()), "vault-flow-cdp-test-"));
  parents.push(profile);
  writeFileSync(join(profile, "DevToolsActivePort"), "60606\n/devtools/browser/fixture\n");
  const root = "/synthetic/vault-flow-smoke-fixture";
  const title = "Settings - vault-flow-smoke-fixture - Obsidian 1.15.0";
  const state = { root, profile, documentTitle: title, clicks: 0, closed: false, focused: false, opened: [] as string[] };
  const targets = [
    { type: "page", url: "app://obsidian.md/index.html", title: "Synthetic vault", webSocketDebuggerUrl: "ws://127.0.0.1:60606/devtools/page/main" },
    { type: "page", url: "about:blank", title, webSocketDebuggerUrl: "ws://127.0.0.1:60606/devtools/page/settings" },
  ];
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(targets))));
  const mainContext = {
    app: { vault: { adapter: { getBasePath: () => state.root } } },
    require: () => ({ app: { getPath: () => state.profile }, getCurrentWindow: () => ({ focus: () => { state.focused = true; } }),
      BrowserWindow: { getAllWindows: () => [{ getTitle: () => title, webContents: { getURL: () => "about:blank" }, close: () => { state.closed = true; } }] } }),
  };
  const settingsContext = { document: { get title() { return state.documentTitle; }, querySelector: () => ({ click: () => { state.clicks++; } }) } };
  class FakeSocket extends EventTarget {
    static OPEN = 1;
    readyState = 0;
    constructor(readonly url: string) {
      super(); state.opened.push(url);
      queueMicrotask(() => { this.readyState = 1; this.dispatchEvent(new Event("open")); });
    }
    send(raw: string): void {
      const message = JSON.parse(raw) as { id: number; method: string; params: { expression?: string; awaitPromise?: boolean } };
      queueMicrotask(() => {
        void (async () => {
          let result: unknown;
          try {
            if (message.method === "Runtime.evaluate") {
              const value: unknown = await runInNewContext(message.params.expression ?? "", this.url.endsWith("/main") ? mainContext : settingsContext);
              result = { result: { value } };
            } else if (message.method === "Page.captureScreenshot") result = { data: "c3ludGhldGlj" };
            else throw new Error("Unexpected mocked CDP method");
          } catch (error) { result = { exceptionDetails: { exception: { description: String(error) } } }; }
          this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ id: message.id, result }) }));
        })();
      });
    }
    close(): void { if (this.readyState === 3) return; this.readyState = 3; this.dispatchEvent(new Event("close")); }
  }
  vi.stubGlobal("WebSocket", FakeSocket);
  return { profile, root, state, targets };
}

describe("isolated native Settings control (mock protocol, not host verification)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    for (const path of parents.splice(0)) rmSync(path, { recursive: true });
  });

  it("guards both identities, awaits results, captures the owned target, and closes only its Settings window", async () => {
    const fixture = setup();
    const session = await connectNativeSettings(fixture);
    try {
      await expect(session.evaluate("doc.querySelector('button').click(); return Promise.resolve(false);")).resolves.toBe(false);
      expect(fixture.state.clicks).toBe(1);
      await expect(session.screenshot()).resolves.toBe("c3ludGhldGlj");
      await session.closeWindow();
      expect(fixture.state.closed).toBe(true);
      expect(fixture.state.focused).toBe(true);
    } finally { session.disconnect(); }
  });

  it.each(["profile", "root"] as const)("rejects a mismatched main %s before connecting to or controlling Settings", async (key) => {
    const fixture = setup(); fixture.state[key] = "/different/identity";
    await expect(connectNativeSettings(fixture)).rejects.toThrow(key === "profile" ? "Smoke profile mismatch" : "Smoke vault mismatch");
    expect(fixture.state.opened).toEqual([fixture.targets[0].webSocketDebuggerUrl]);
    expect(fixture.state.clicks).toBe(0);
  });

  it("rejects duplicate native Settings targets rather than choosing the first one", async () => {
    const fixture = setup(); fixture.targets.push({ ...fixture.targets[1] });
    await expect(connectNativeSettings(fixture)).rejects.toThrow("Expected one isolated settings target");
    expect(fixture.state.opened).toEqual([]);
  });

  it("rejects a target escaping the exact loopback debugging endpoint", async () => {
    const fixture = setup(); fixture.targets[1].webSocketDebuggerUrl = "ws://127.0.0.1:60607/devtools/page/other";
    await expect(connectNativeSettings(fixture)).rejects.toThrow("escaped");
    expect(fixture.state.opened).toEqual([]);
  });

  it("rejects a Settings document that no longer matches the selected target", async () => {
    const fixture = setup(); fixture.state.documentTitle = "Settings - other-vault - Obsidian 1.15.0";
    await expect(connectNativeSettings(fixture)).rejects.toThrow("Smoke settings target mismatch");
    expect(fixture.state.clicks).toBe(0);
  });

  it("rechecks the main profile before every Settings operation", async () => {
    const fixture = setup(); const session = await connectNativeSettings(fixture);
    try {
      fixture.state.profile = "/different/profile";
      await expect(session.evaluate("doc.querySelector('button').click(); return true;")).rejects.toThrow("Smoke profile mismatch");
      expect(fixture.state.clicks).toBe(0);
      await expect(session.closeWindow()).rejects.toThrow("Smoke profile mismatch");
      expect(fixture.state.closed).toBe(false);
    } finally { session.disconnect(); }
  });

  it("rejects an elapsed deadline without opening a debugging connection", async () => {
    const fixture = setup();
    await expect(connectNativeSettings({ ...fixture, deadlineAt: Date.now() - 1 })).rejects.toThrow("deadline exceeded");
    expect(fixture.state.opened).toEqual([]);
  });
});
