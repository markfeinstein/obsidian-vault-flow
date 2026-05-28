import { describe, expect, it } from "vitest";
import { TFile, type App } from "obsidian";
import { captureNoteIdentity, sameNoteIdentity } from "../../src/obsidian/note-identity";
import { sanitizeVaultFlowRuntimeState } from "../../src/obsidian/settings";

function fixture() {
  const file = new TFile();
  file.path = "A.md";
  file.stat = { ctime: 1, mtime: 2, size: 3 };
  const app = { vault: { read: async () => "abc" } } as unknown as App;
  return { app, file };
}

describe("undo note identity", () => {
  it("uses SHA-256 and file stats, and round-trips through runtime persistence", async () => {
    const { app, file } = fixture();
    const identity = await captureNoteIdentity(app, file);
    expect(identity.sha256).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(sameNoteIdentity(identity, { ...identity, ctime: 99 })).toBe(false);
    const transaction = { timestamp: Date.now(), path: "A.md", desiredPath: "B.md", outcome: "changed",
      appliedRuleIds: [], involvedRuleIds: [], mutationKinds: ["move"], iterations: 1, afterIdentity: identity };
    const stored = sanitizeVaultFlowRuntimeState({ transactions: [transaction] });
    expect(stored.runtimeState.transactions?.[0]?.afterIdentity).toEqual(identity);
    expect(sanitizeVaultFlowRuntimeState({ transactions: [{ ...transaction, afterIdentity: { sha256: "bad" } }] }).runtimeState.transactions).toEqual([]);
  });

  it("rejects changes during a read instead of recording a mixed identity", async () => {
    const { app, file } = fixture();
    app.vault.read = async () => { file.stat.mtime += 1; return "abc"; };
    await expect(captureNoteIdentity(app, file)).rejects.toThrow("changed while");
  });
});
