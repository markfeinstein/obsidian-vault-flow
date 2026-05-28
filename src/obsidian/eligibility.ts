import { compilePathGlob } from "../engine/path-glob";
import { normalizePath, type CachedMetadata, type TFile } from "obsidian";
import { isProcessableFile } from "./adapter";

export interface FileEligibilitySettings {
  readonly monitoredFolders: readonly string[];
  readonly exclusionPatterns: readonly string[];
  readonly disableFrontmatterKey: string;
}

export type FileEligibility =
  | { readonly eligible: true }
  | { readonly eligible: false; readonly reason: "unsupported" | "metadata-unavailable" | "outside-monitored-folders" | "excluded" | "disabled"; readonly message: string };

export function evaluateFileEligibility(
  file: TFile,
  cache: CachedMetadata | null,
  settings: FileEligibilitySettings,
): FileEligibility {
  if (!isProcessableFile(file)) {
    return { eligible: false, reason: "unsupported", message: "This file type is not processable by Vault Flow." };
  }

  if (cache === null) {
    return { eligible: false, reason: "metadata-unavailable", message: "Obsidian metadata is not available for this note yet." };
  }

  if (!isInMonitoredFolder(file.path, settings.monitoredFolders)) {
    return { eligible: false, reason: "outside-monitored-folders", message: "This note is outside the monitored folders." };
  }

  const disableKey = settings.disableFrontmatterKey.trim();
  if (disableKey.length > 0 && isDisabledValue(cache.frontmatter?.[disableKey])) {
    return { eligible: false, reason: "disabled", message: `This note has '${disableKey}' set to a disabling value.` };
  }

  if (settings.exclusionPatterns.some((pattern) => globMatchesPath(pattern, file.path))) {
    return { eligible: false, reason: "excluded", message: "This note matches an exclusion pattern." };
  }

  return { eligible: true };
}

export function isDisabledValue(value: unknown): boolean {
  // Scope controls fail closed: match JavaScript/YAML truthiness rather than a
  // short allowlist of spellings that could leave an intended exclusion active.
  return Boolean(value);
}

export function isInMonitoredFolder(path: string, monitoredFolders: readonly string[]): boolean {
  if (monitoredFolders.length === 0) {
    return true;
  }

  const normalizedPath = normalizePath(path);
  return monitoredFolders.some((folder) => {
    const normalizedFolder = normalizePath(folder);
    return normalizedPath === normalizedFolder || normalizedPath.startsWith(`${normalizedFolder}/`);
  });
}

/**
 * Matches a normalized vault path against a small glob dialect:
 * `*` matches within a path segment, `**` across segments, and `?` one character.
 * A folder match also excludes all descendants of that folder.
 */
export function globMatchesPath(glob: string, path: string): boolean {
  const normalizedGlob = normalizePath(glob.trim());
  if (normalizedGlob.length === 0) {
    return false;
  }

  const normalizedPath = normalizePath(path);
  const pattern = compilePathGlob(normalizedGlob, "iu");
  if (pattern.test(normalizedPath)) {
    return true;
  }

  const segments = normalizedPath.split("/");
  let cumulative = "";
  for (const segment of segments) {
    cumulative = cumulative.length === 0 ? segment : `${cumulative}/${segment}`;
    if (pattern.test(cumulative)) {
      return true;
    }
  }

  return false;
}
