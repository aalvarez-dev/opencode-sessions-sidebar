import { expect, test } from "bun:test";
import { parseDesignClick } from "../scripts/lib/terminal-design-input";

test("design relay only accepts a fresh visible-cell onboarding click", () => {
  const request = { id: 1, type: "close-native-onboarding", column: 137, row: 31 };
  expect(parseDesignClick(request, 140, 48, 0)).toEqual({ id: 1, column: 137, row: 31 });
  for (const invalid of [
    null,
    [],
    { ...request, type: "command" },
    { ...request, text: "unexpected" },
    { ...request, id: 0 },
    { ...request, column: 141 },
    { ...request, row: 49 },
    { ...request, column: 0 },
    { ...request, row: 1.5 },
  ])
    expect(() => parseDesignClick(invalid, 140, 48, 0)).toThrow();
  expect(() => parseDesignClick(request, 140, 48, 1)).toThrow();
  expect(() => parseDesignClick(request, 120, 48, 0)).toThrow();
});
