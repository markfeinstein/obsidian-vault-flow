// Small, inspectable DOM double for headless rendering and event tests.
// This is not a substitute for accessibility/browser checks in Obsidian.
interface ElementOptions {
  text?: string;
  type?: string;
  cls?: string;
  attr?: Record<string, string>;
}

export class TestElement {
  readonly children: TestElement[] = [];
  readonly attributes: Record<string, string> = {};
  private readonly listeners = new Map<string, Array<() => void>>();
  textContent = "";
  disabled = false;
  checked = false;
  open = false;
  onclick: (() => void | Promise<void>) | null = null;

  constructor(readonly tag = "div", options: ElementOptions = {}) {
    this.textContent = options.text ?? "";
    Object.assign(this.attributes, options.attr);
    if (options.type !== undefined) this.attributes.type = options.type;
    if (options.cls !== undefined) this.attributes.class = options.cls;
  }

  asElement(): HTMLElement { return this as unknown as HTMLElement; }
  empty(): void { this.children.length = 0; }
  setText(text: string): void { this.textContent = text; }
  addClass(cls: string): void { this.attributes.class = `${this.attributes.class ?? ""} ${cls}`.trim(); }
  createEl(tag: string, options?: ElementOptions): TestElement {
    const child = new TestElement(tag, options);
    this.children.push(child);
    return child;
  }
  createDiv(options?: ElementOptions): TestElement { return this.createEl("div", options); }
  createSpan(options?: ElementOptions): TestElement { return this.createEl("span", options); }
  addEventListener(event: string, callback: () => void): void {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), callback]);
  }
  onClickEvent(callback: () => void): void { this.addEventListener("click", callback); }
  async fire(event: string): Promise<void> {
    if (this.disabled) return;
    for (const callback of this.listeners.get(event) ?? []) callback();
    if (event === "click") await this.onclick?.();
  }
  all(tag: string): TestElement[] {
    return this.children.flatMap((child) => [...(child.tag === tag ? [child] : []), ...child.all(tag)]);
  }
}
