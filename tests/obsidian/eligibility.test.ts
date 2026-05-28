import { describe, expect, it } from "vitest";
import { isDisabledValue } from "../../src/obsidian/eligibility";

describe("per-note disable values", () => {
  it.each([
    true,
    1,
    -1,
    "true",
    "yes",
    "on",
    "1",
    "skip this note",
    [],
    {},
  ])("treats truthy YAML/frontmatter value %j as disabling", (value) => {
    expect(isDisabledValue(value)).toBe(true);
  });

  it.each([false, 0, "", null, undefined])("does not disable for falsey value %j", (value) => {
    expect(isDisabledValue(value)).toBe(false);
  });
});
