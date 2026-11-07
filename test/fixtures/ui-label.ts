import assert from "node:assert/strict";
import { createComponent, createSignal } from "solid-js";
import { testRender } from "@opentui/solid";
import { EndLabel } from "../../src/ui/end-label";

const [text, setText] = createSignal("Active session:");
const [ellipsis, setEllipsis] = createSignal("…");
const native = await testRender(
  () =>
    createComponent(EndLabel, {
      id: "measured-label",
      fg: "#ffffff",
      get text() {
        return text();
      },
      get ellipsis() {
        return ellipsis();
      },
    }),
  { width: 24, height: 2 },
);
const frame = async () => {
  await native.flush();
  return native.captureCharFrame().split("\n")[0]!.trimEnd();
};
try {
  assert.equal(await frame(), "Active session:");
  setText("A long session title with an important beginning");
  assert.equal(await frame(), "A long session title wi…");
  native.resize(12, 2);
  assert.equal(await frame(), "A long sess…");
  native.resize(60, 2);
  assert.equal(await frame(), text());
  setText("Updated after first layout");
  assert.equal(await frame(), text());
  native.resize(5, 2);
  setText("漢字語文");
  assert.equal(await frame(), "漢字…");
  setText("e\u0301abcdef");
  assert.equal(await frame(), "e\u0301abc…");
  setEllipsis("...");
  setText("abcdefghi");
  assert.equal(await frame(), "ab...");
  native.resize(1, 2);
  assert.equal((await frame()).length, 1);
  native.resize(24, 2);
  assert.equal(await frame(), "abcdefghi");
} finally {
  native.renderer.destroy();
}
console.log(JSON.stringify({ scope: "native-opentui-label", passed: true }));
