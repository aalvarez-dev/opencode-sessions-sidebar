import assert from "node:assert/strict";
import { Show, createComponent, createSignal } from "solid-js";
import { testRender } from "@opentui/solid";
import { EndLabel } from "../../src/ui/end-label";

const [mounted, setMounted] = createSignal(false);
const [text, setText] = createSignal("Active session:");
const [ellipsis, setEllipsis] = createSignal("…");
const native = await testRender(
  () =>
    createComponent(Show, {
      keyed: true,
      get when() {
        return mounted();
      },
      get children() {
        return createComponent(EndLabel, {
          id: "measured-label",
          fg: "#ffffff",
          get text() {
            return text();
          },
          get ellipsis() {
            return ellipsis();
          },
        });
      },
    }),
  { width: 24, height: 2 },
);
const frame = async () => {
  await native.flush();
  return native.captureCharFrame().split("\n")[0]!.trimEnd();
};
const painted: { text: string; width: number }[] = [];
const observePaint = () => {
  const label = native.renderer.root.findDescendantById("measured-label");
  if (label && label.width > 0)
    painted.push({ text: native.captureCharFrame().split("\n")[0]!.trimEnd(), width: label.width });
};
native.renderer.on("frame", observePaint);
const remountAndCheckFirstPaint = async (label: string) => {
  setMounted(false);
  await native.flush();
  setText(label);
  painted.length = 0;
  setMounted(true);
  await native.flush();
  assert(painted.length > 0, "A mounted label must produce a native frame.");
  assert(
    painted[0]!.text.startsWith(label.slice(0, Math.min(4, painted[0]!.width))),
    `The first painted frame must contain the label: ${JSON.stringify(painted[0])}`,
  );
  assert(
    painted.every((paint) => paint.text.length > 0),
    "No visible mounted label may paint blank.",
  );
};
try {
  await remountAndCheckFirstPaint("Active session:");
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
  // The viewport destroys offscreen rows and mounts them again after scrolling.
  // Check the first painted frame of each fresh instance, not only its idle state.
  for (let index = 0; index < 5; index++) {
    native.resize(index % 2 ? 12 : 24, 2);
    await remountAndCheckFirstPaint(`Remounted session ${index} with a long title`);
  }
} finally {
  native.renderer.off("frame", observePaint);
  native.renderer.destroy();
}
console.log(JSON.stringify({ scope: "native-opentui-label", passed: true }));
