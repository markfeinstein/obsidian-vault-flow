import type { App } from "obsidian";
import { DEFAULT_SETTINGS, sanitizeVaultFlowSettings, settingsDataForSave, type VaultFlowSettings } from "./settings";

export const SETTINGS_HISTORY_KEY = "vault-flow:settings-revisions:v1";
export const MAX_SETTINGS_REVISIONS = 20;
export const MAX_SETTINGS_REVISION_BYTES = 512 * 1024;
export const MAX_SETTINGS_HISTORY_BYTES = 2 * 1024 * 1024;
const CONFIG_KEYS = new Set(Object.keys(settingsDataForSave(DEFAULT_SETTINGS)));
const LOSSLESS_ERROR = "This revision cannot be restored losslessly by this plugin version. Copy its JSON and inspect it manually.";
const SOURCES = ["startup", "before-change", "edit", "external", "restore"] as const;
export type SettingsRevisionSource = typeof SOURCES[number];
export interface SettingsRevision {
  readonly id: string;
  readonly timestamp: number;
  readonly source: SettingsRevisionSource;
  /** Canonical configuration only. Runtime diagnostics, note bodies, and undo data are never included. */
  readonly data: string;
}
const byteLength = (value: string): number => new TextEncoder().encode(value).byteLength;
const envelope = (revisions: readonly SettingsRevision[]): { version: number; revisions: readonly SettingsRevision[] } => ({ version: 1, revisions });
const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

export class SettingsRevisionHistory {
  private revisions: readonly SettingsRevision[] = [];
  private sequence = 0;
  public readonly blockedReason: string | null;
  public constructor(private readonly app: Pick<App, "loadLocalStorage" | "saveLocalStorage">, private readonly now: () => number = () => Date.now()) {
    try {
      const raw: unknown = app.loadLocalStorage(SETTINGS_HISTORY_KEY);
      if (raw !== null && raw !== undefined) this.revisions = readRevisions(raw);
      this.blockedReason = null;
    } catch {
      this.blockedReason = "Settings revision storage could not be read, is invalid, or uses an unsupported format. It has not been overwritten; keep an independent configuration backup.";
    }
  }
  public entries(): readonly SettingsRevision[] { return this.revisions.map((revision) => ({ ...revision })); }
  public capture(settings: VaultFlowSettings, source: SettingsRevisionSource): void {
    if (this.blockedReason !== null) throw new Error(this.blockedReason);
    const data = JSON.stringify(settingsDataForSave(settings));
    if (data.length > MAX_SETTINGS_REVISION_BYTES || byteLength(data) > MAX_SETTINGS_REVISION_BYTES) throw new Error("Configuration exceeds the 512 KiB revision limit; keep an independent configuration backup.");
    if (this.revisions.at(-1)?.data === data) return;
    const timestamp = this.now();
    let id: string;
    do { id = `settings-${timestamp}-${++this.sequence}`; } while (this.revisions.some((revision) => revision.id === id));
    let next = [...this.revisions, { id, timestamp, source, data }].slice(-MAX_SETTINGS_REVISIONS);
    while (byteLength(JSON.stringify(envelope(next))) > MAX_SETTINGS_HISTORY_BYTES) next = next.slice(1);
    // Commit memory only after local storage accepts the entire bounded snapshot.
    this.app.saveLocalStorage(SETTINGS_HISTORY_KEY, envelope(next));
    this.revisions = next;
  }
  public candidate(id: string): VaultFlowSettings {
    const revision = this.revisions.find((entry) => entry.id === id);
    if (revision === undefined) throw new Error("This settings revision is no longer retained. Refresh history.");
    const raw: unknown = JSON.parse(revision.data);
    // Reject runtime payloads/unknown fields before invoking any settings
    // sanitizers. Only this module's complete configuration shape is restorable.
    if (!record(raw) || Object.keys(raw).length !== CONFIG_KEYS.size || Object.keys(raw).some((key) => !CONFIG_KEYS.has(key))) throw new Error(LOSSLESS_ERROR);
    const result = sanitizeVaultFlowSettings(raw);
    if (result.sanitized || result.incompatibleVersion !== undefined || result.regexErrors !== undefined || result.scopeErrors !== undefined || result.ruleErrors !== undefined
      || JSON.stringify(settingsDataForSave(result.settings)) !== revision.data) {
      throw new Error(LOSSLESS_ERROR);
    }
    return result.settings;
  }
}
function readRevisions(raw: unknown): readonly SettingsRevision[] {
  if (!record(raw) || raw.version !== 1 || !Array.isArray(raw.revisions) || raw.revisions.length > MAX_SETTINGS_REVISIONS) throw new Error("Unsupported history");
  const ids = new Set<string>();
  const revisions: SettingsRevision[] = [];
  for (const value of raw.revisions as unknown[]) {
    if (!record(value) || typeof value.id !== "string" || value.id.length === 0 || value.id.length > 100 || ids.has(value.id)
      || typeof value.timestamp !== "number" || !Number.isSafeInteger(value.timestamp) || value.timestamp < 0
      || !SOURCES.some((source) => source === value.source) || typeof value.data !== "string"
      || value.data.length > MAX_SETTINGS_REVISION_BYTES || byteLength(value.data) > MAX_SETTINGS_REVISION_BYTES) throw new Error("Invalid history entry");
    ids.add(value.id);
    revisions.push({ id: value.id, timestamp: value.timestamp, source: value.source as SettingsRevisionSource, data: value.data });
  }
  if (byteLength(JSON.stringify(envelope(revisions))) > MAX_SETTINGS_HISTORY_BYTES) throw new Error("History exceeds byte budget");
  return revisions;
}
