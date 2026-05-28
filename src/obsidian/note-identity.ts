import type { App, TFile } from "obsidian";

/** Conservative after-state identity: any later edit makes undo unavailable. */
export interface NoteIdentity {
  readonly ctime: number;
  readonly mtime: number;
  readonly size: number;
  readonly sha256: string;
}

export async function captureNoteIdentity(app: App, file: TFile): Promise<NoteIdentity> {
  const path = file.path;
  const { ctime, mtime, size } = file.stat;
  const content = await app.vault.read(file);
  const digest = await window.crypto.subtle.digest("SHA-256", new TextEncoder().encode(content));
  if (file.path !== path || file.stat.ctime !== ctime || file.stat.mtime !== mtime || file.stat.size !== size) {
    throw new Error("The note changed while its undo identity was being captured.");
  }
  return { ctime, mtime, size, sha256: Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("") };
}

export function sameNoteIdentity(left: NoteIdentity, right: NoteIdentity): boolean {
  return left.ctime === right.ctime && left.mtime === right.mtime && left.size === right.size && left.sha256 === right.sha256;
}
