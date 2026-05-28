export class Notice {
  constructor(public readonly message: string) {}
}

export class TFolder {
  children: unknown[] = [];
  name = "";
  parent: TFolder | null = null;
  path = "";

  isRoot(): boolean {
    return this.path === "";
  }
}

export class TFile {
  name = "";
  basename = "";
  extension = "";
  path = "";
  parent: TFolder | null = null;
  stat = { ctime: 0, mtime: 0, size: 0 };
}

export const Vault = {
  recurseChildren(root: TFolder, callback: (file: TFile | TFolder) => void): void {
    callback(root);
    for (const child of root.children) {
      if (child instanceof TFolder) Vault.recurseChildren(child, callback);
      else if (child instanceof TFile) callback(child);
    }
  },
};

export class TExternalFile extends TFile {
  getRealPath(): string { return this.path; }
}

export class Plugin {
  public app: unknown;
  public readonly registeredEvents: unknown[] = [];
  public readonly registeredIntervals: number[] = [];
  public readonly commands: unknown[] = [];
  public readonly cliHandlers: Array<{ command: string; description: string; flags: unknown; handler: (params: Record<string, string>) => string | Promise<string> }> = [];
  public readonly settingTabs: unknown[] = [];
  private data: unknown = undefined;

  constructor(app?: unknown) {
    this.app = app;
  }

  async loadData(): Promise<unknown> {
    return this.data;
  }

  async saveData(data: unknown): Promise<void> {
    this.data = data;
  }

  registerEvent(event: unknown): void {
    this.registeredEvents.push(event);
  }

  registerInterval(interval: number): number {
    this.registeredIntervals.push(interval);
    return interval;
  }

  addStatusBarItem(): HTMLElement {
    return { textContent: "" } as HTMLElement;
  }

  addSettingTab(tab: unknown): void {
    this.settingTabs.push(tab);
  }

  addCommand(command: unknown): void {
    this.commands.push(command);
  }

  registerView(_type: string, _factory: unknown): void {}
  registerHoverLinkSource(_id: string, _info: unknown): void {}
  registerBasesView(_type: string, _registration: unknown): boolean { return true; }
  registerCliHandler(command: string, description: string, flags: unknown, handler: (params: Record<string, string>) => string | Promise<string>): void {
    this.cliHandlers.push({ command, description, flags, handler });
  }
}

export class PluginSettingTab {
  public containerEl = elementShim();
  public icon = "";

  constructor(public readonly app: unknown, public readonly plugin: unknown) {}

  getSettingDefinitions(): unknown[] { return []; }
  getControlValue(_key: string): unknown { return undefined; }
  setControlValue(_key: string, _value: unknown): void {}
  update(): void {}
  refreshDomState(): void {}
  display(): void {}
}

export class ErrorValue {
  toString(): string { return "error"; }
  isTruthy(): boolean { return false; }
}

export class StringValue {
  constructor(protected readonly value: string) {}
  toString(): string { return this.value; }
  isTruthy(): boolean { return this.value.length > 0; }
}

export class LinkValue extends StringValue {}

export class FileValue extends StringValue {}

export class BooleanValue {
  constructor(private readonly value: boolean) {}
  toString(): string { return String(this.value); }
  isTruthy(): boolean { return this.value; }
}

export class NumberValue {
  constructor(private readonly value: number) {}
  toString(): string { return String(this.value); }
  isTruthy(): boolean { return this.value !== 0; }
}

export class ListValue {
  constructor(private readonly values: unknown[]) {}
  toString(): string { return this.values.join(", "); }
  isTruthy(): boolean { return this.values.length > 0; }
}

export function parseLinktext(linktext: string): { path: string; subpath: string } {
  const subpathIndex = linktext.search(/[#^]/u);
  return subpathIndex === -1
    ? { path: linktext, subpath: "" }
    : { path: linktext.slice(0, subpathIndex), subpath: linktext.slice(subpathIndex) };
}

export function getLinkpath(linktext: string): string {
  return parseLinktext(linktext).path;
}

export class BasesView {
  public app = {} as App;
  public config = {
    get: (_key: string) => undefined,
    getAsPropertyId: (_key: string) => null,
    getDisplayName: (key: string) => key,
  };
  public data = {
    data: [] as unknown[],
    get groupedData() {
      return [{ key: undefined, entries: this.data, hasKey: () => false }];
    },
  };

  constructor(public readonly controller: unknown) {}
  onDataUpdated(): void {}
  onunload(): void {}
}

export class ItemView {
  public contentEl = elementShim();

  constructor(public readonly leaf: unknown) {}

  getViewType(): string {
    return "";
  }

  getDisplayText(): string {
    return "";
  }

  getIcon(): string {
    return "";
  }
}

export class Modal {
  public contentEl = elementShim();

  constructor(public readonly app: unknown) {}

  open(): void {}
  close(): void {}
  setTitle(_title: string): this { return this; }
  setContent(_content: string): this { return this; }
  setCloseCallback(_callback: () => void): this { return this; }
}

export class ConfirmationModal extends Modal {
  addButton(_callback: (button: ConfirmationButton) => void): this { return this; }
  addCancelButton(_text?: string): this { return this; }
}

export class FuzzySuggestModal<T> extends Modal {
  setPlaceholder(_placeholder: string): void {}
  getItems(): T[] { return []; }
  getItemText(_item: T): string { return ""; }
  onChooseItem(_item: T): void {}
}

export class Setting {
  public settingEl = elementShim();

  constructor(public readonly containerEl: unknown) {}

  setName(_name: string): this { return this; }
  setDesc(_desc: string): this { return this; }
  addToggle(_callback: (component: ToggleComponent) => void): this { return this; }
  addDropdown(_callback: (component: DropdownComponent) => void): this { return this; }
  addText(_callback: (component: TextComponent) => void): this { return this; }
  addTextArea(_callback: (component: TextAreaComponent) => void): this { return this; }
  addButton(_callback: (component: ButtonComponent) => void): this { return this; }
}

export class ToggleComponent {
  setValue(_value: boolean): this { return this; }
  onChange(_callback: (value: boolean) => void | Promise<void>): this { return this; }
}

export class DropdownComponent {
  addOption(_value: string, _display: string): this { return this; }
  setValue(_value: string): this { return this; }
  onChange(_callback: (value: string) => void | Promise<void>): this { return this; }
}

export class TextComponent {
  public inputEl: { readOnly?: boolean } = {};
  setPlaceholder(_value: string): this { return this; }
  setValue(_value: string): this { return this; }
  onChange(_callback: (value: string) => void | Promise<void>): this { return this; }
}

export class TextAreaComponent extends TextComponent {}

export class ButtonComponent {
  setButtonText(_value: string): this { return this; }
  setCta(): this { return this; }
  setDestructive(): this { return this; }
  setTooltip(_value: string): this { return this; }
  setIcon(_value: string): this { return this; }
  onClick(_callback: () => void | Promise<void>): this { return this; }
}

export class ConfirmationButton extends ButtonComponent {
  setInitialFocus(): this { return this; }
}

export class ProgressBarComponent {
  constructor(public readonly containerEl: unknown) {}
  setValue(_value: number): this { return this; }
  getValue(): number { return 0; }
}

export function prepareFuzzySearch(query: string): (text: string) => { score: number; matches: unknown[] } | null {
  const normalizedQuery = query.toLocaleLowerCase();
  return (text) => {
    const normalizedText = text.toLocaleLowerCase();
    let queryIndex = 0;
    for (const character of normalizedText) {
      if (character === normalizedQuery[queryIndex]) queryIndex += 1;
      if (queryIndex === normalizedQuery.length) return { score: 0, matches: [] };
    }
    return normalizedQuery.length === 0 ? { score: 0, matches: [] } : null;
  };
}

export function debounce<T extends unknown[], V>(
  callback: (...args: T) => V,
  timeout = 0,
  resetTimer = false,
): ((...args: T) => unknown) & { cancel: () => unknown; run: () => V | undefined } {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pendingArgs: T | null = null;
  const debounced = ((...args: T) => {
    pendingArgs = args;
    if (resetTimer && timer !== null) clearTimeout(timer);
    if (timer === null || resetTimer) {
      timer = setTimeout(() => {
        timer = null;
        const nextArgs = pendingArgs;
        pendingArgs = null;
        if (nextArgs !== null) callback(...nextArgs);
      }, timeout);
    }
    return debounced;
  }) as ((...args: T) => unknown) & { cancel: () => unknown; run: () => V | undefined };
  debounced.cancel = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    pendingArgs = null;
    return debounced;
  };
  debounced.run = () => {
    if (timer === null || pendingArgs === null) return undefined;
    clearTimeout(timer);
    timer = null;
    const nextArgs = pendingArgs;
    pendingArgs = null;
    return callback(...nextArgs);
  };
  return debounced;
}

export function moment(input?: number | Date): { format: (pattern: string) => string } {
  const date = input instanceof Date ? input : new Date(input ?? Date.now());
  const replacements: Record<string, string> = {
    YYYY: String(date.getFullYear()),
    MM: String(date.getMonth() + 1).padStart(2, "0"),
    DD: String(date.getDate()).padStart(2, "0"),
    HH: String(date.getHours()).padStart(2, "0"),
    mm: String(date.getMinutes()).padStart(2, "0"),
    ss: String(date.getSeconds()).padStart(2, "0"),
  };
  return {
    format: (pattern) => Object.entries(replacements).reduce((value, [token, replacement]) => value.split(token).join(replacement), pattern),
  };
}

export const Platform = {
  isMobileApp: false,
};

export const Keymap = {
  isModEvent: (_event: unknown): boolean => false,
};

export function getAllTags(cache: CachedMetadata): string[] | null {
  const tags = new Set<string>();
  for (const tag of cache.tags ?? []) {
    tags.add(tag.tag.startsWith("#") ? tag.tag : `#${tag.tag}`);
  }
  for (const tag of parseFrontMatterTags(cache.frontmatter ?? null) ?? []) {
    tags.add(tag.startsWith("#") ? tag : `#${tag}`);
  }
  return tags.size === 0 ? null : [...tags];
}

export function parseFrontMatterTags(frontmatter: Record<string, unknown> | null): string[] | null {
  const value = frontmatter?.tags;
  if (typeof value === "string") {
    return value.split(/[\s,]+/u).filter((tag) => tag.length > 0);
  }
  if (Array.isArray(value)) {
    return value.filter((tag): tag is string => typeof tag === "string");
  }
  return null;
}

export interface FrontMatterInfo {
  exists: boolean;
  frontmatter: string;
  from: number;
  to: number;
  contentStart: number;
}

export function getFrontMatterInfo(content: string): FrontMatterInfo {
  const opening = /^(?:\uFEFF)?---(?:\r?\n|$)/u.exec(content);
  if (opening === null) {
    return { exists: false, frontmatter: "", from: 0, to: 0, contentStart: 0 };
  }
  const from = opening[0].length;
  const closing = /(?:^|\r?\n)---[ \t]*(?:\r?\n|$)/gmu;
  closing.lastIndex = from;
  const match = closing.exec(content);
  if (match === null) {
    return { exists: false, frontmatter: "", from: 0, to: 0, contentStart: 0 };
  }
  const delimiterOffset = match.index + (match[0].startsWith("\n") ? 1 : match[0].startsWith("\r\n") ? 2 : 0);
  return {
    exists: true,
    frontmatter: content.slice(from, delimiterOffset),
    from,
    to: delimiterOffset,
    contentStart: match.index + match[0].length,
  };
}

export function normalizePath(path: string): string {
  return path
    .replace(/\\/g, "/")
    .replace(/\/{2,}/g, "/")
    .replace(/^\.\//, "")
    .replace(/\/$/, "");
}

function elementShim(): HTMLElement {
  const element = {
    textContent: "",
    value: "",
    selected: false,
    disabled: false,
    checked: false,
    empty() {},
    setText(value: string) { this.textContent = value; },
    createDiv(_options?: unknown) { return elementShim(); },
    createEl(_tag: string, _options?: unknown) { return elementShim(); },
    addEventListener(_event: string, _callback: EventListener) {},
    onClickEvent(_callback: (event: MouseEvent) => void) {},
  };
  return element as unknown as HTMLElement;
}

export interface App {
  loadLocalStorage?: (key: string) => unknown;
  saveLocalStorage?: (key: string, value: unknown) => void;
  metadataCache: {
    on?: (name: string, callback: (...args: unknown[]) => void) => unknown;
    getFileCache: (file: TFile) => CachedMetadata | null;
  };
  fileManager: {
    processFrontMatter: (file: TFile, processor: (frontmatter: Record<string, unknown>) => void) => Promise<void>;
    renameFile: (file: TFile, path: string) => Promise<void>;
  };
  vault: {
    on?: (name: string, callback: (...args: unknown[]) => void) => unknown;
    configDir?: string;
    getMarkdownFiles?: () => TFile[];
    getAllFolders?: (includeRoot?: boolean) => TFolder[];
    getFileByPath?: (path: string) => TFile | null;
    getAbstractFileByPath: (path: string) => TAbstractFile | null;
    create?: (path: string, content: string) => Promise<TFile>;
    createFolder: (path: string) => Promise<TFolder>;
    cachedRead?: (file: TFile) => Promise<string>;
  };
  workspace: {
    on?: (name: string, callback: (...args: unknown[]) => void) => unknown;
    onLayoutReady?: (callback: () => void) => void;
    getActiveFile?: () => TFile | null;
    getLeavesOfType?: (type: string) => unknown[];
    getRightLeaf?: (create: boolean) => { setViewState: (state: unknown) => Promise<void> } | null;
    revealLeaf?: (leaf: unknown) => Promise<void>;
    ensureSideLeaf?: (type: string, side: string, options?: unknown) => Promise<unknown>;
  };
}

export interface CachedMetadata {
  frontmatter?: Record<string, unknown>;
  tags?: Array<{ tag: string }>;
  headings?: Array<HeadingCache>;
}

export interface HeadingCache {
  heading: string;
  level: number;
  position: unknown;
}

export type Menu = unknown;
export type TAbstractFile = TFile | TFolder;
export type WorkspaceLeaf = unknown;
