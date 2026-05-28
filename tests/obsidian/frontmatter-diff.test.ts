import { describe, expect, it } from "vitest";
import type { NoteState } from "../../src/engine";
import { frontmatterDiff, renderFrontmatterDiff } from "../../src/obsidian/frontmatter-diff";
import { TestElement } from "../helpers/dom";

const note: NoteState = { path: "A.md", basename: "A", extension: "md", tags: [], frontmatter: {} };

describe("shared property review details", () => {
  it("shows added, deleted, null, and unsupported nested values accurately", () => {
    const current = { ...note, frontmatter: { nullValue: null, removed: 1 }, frontmatterKeys: ["nullValue", "removed", "nested"], rawFrontmatter: { nested: { children: [1, 2] } } };
    const desired = { ...note, frontmatter: { nullValue: "set", added: false }, frontmatterKeys: ["nullValue", "added"] };
    const changes = frontmatterDiff(current, desired);
    expect(changes.find((change) => change.property === "nullValue")).toMatchObject({ before: "null", after: '"set"' });
    expect(changes.find((change) => change.property === "added")).toMatchObject({ before: "(absent)", after: "false" });
    expect(changes.find((change) => change.property === "removed")).toMatchObject({ before: "1", after: "(absent)" });
    expect(changes.find((change) => change.property === "nested")?.before).toContain("children");
    expect(changes.find((change) => change.property === "nested")?.after).toBe("(absent)");
  });

  it("does not show unrelated unsupported values as changes", () => {
    const current = { ...note, frontmatterKeys: ["nested"], rawFrontmatter: { nested: { children: [1] } } };
    expect(frontmatterDiff(current, current)).toEqual([]);
  });

  it("lazily renders safe text nodes once when expanded", async () => {
    const root = new TestElement();
    renderFrontmatterDiff(root.asElement(), note, { ...note, frontmatter: { title: "<script>not HTML</script>" } });
    expect(root.all("table")).toHaveLength(0);
    const details = root.all("details")[0];
    details.open = true;
    await details.fire("toggle");
    expect(root.all("table")).toHaveLength(1);
    expect(root.all("script")).toHaveLength(0);
    expect(root.all("pre").some((element) => element.textContent.includes("<script>"))).toBe(true);
    await details.fire("toggle");
    expect(root.all("table")).toHaveLength(1);
  });
});
