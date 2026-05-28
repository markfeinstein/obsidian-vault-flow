import type { TAbstractFile, TFile } from "obsidian";

export function markdownFilesInSameFolder(file: TFile): readonly TFile[] | null {
  const folder = file.parent;
  if (folder === null) {
    return null;
  }

  return folder.children.filter(isMarkdownTFile).sort(compareFilesByPath);
}

export function selectedMarkdownFiles(files: readonly TAbstractFile[]): readonly TFile[] {
  const paths = new Set<string>();
  const selectedFiles: TFile[] = [];

  for (const file of files) {
    if (!isMarkdownTFile(file) || paths.has(file.path)) {
      continue;
    }

    paths.add(file.path);
    selectedFiles.push(file);
  }

  return selectedFiles;
}

function isMarkdownTFile(file: TAbstractFile): file is TFile {
  return hasStringProperty(file, "extension") && file.extension.toLowerCase() === "md";
}

function hasStringProperty(file: TAbstractFile, property: "extension"): file is TAbstractFile & Record<typeof property, string> {
  return property in file && typeof file[property] === "string";
}

function compareFilesByPath(left: TFile, right: TFile): number {
  return left.path.toLowerCase().localeCompare(right.path.toLowerCase()) || left.path.localeCompare(right.path);
}
