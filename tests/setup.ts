// Obsidian runs plugins in a browser window. Keep the Node test environment light
// while exposing the window timer methods used for pop-out-window compatibility.
if (typeof window === "undefined") {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      crypto: globalThis.crypto,
      setTimeout: (handler: () => void, timeout?: number) => globalThis.setTimeout(handler, timeout),
      clearTimeout: (handle: ReturnType<typeof globalThis.setTimeout>) => globalThis.clearTimeout(handle),
    },
  });
}
