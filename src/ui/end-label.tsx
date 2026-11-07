import { createSignal, splitProps } from "solid-js";
import type { JSX } from "@opentui/solid";

export type EndLabelProps = Omit<JSX.IntrinsicElements["text"], "children"> & {
  text: string;
  ellipsis?: string;
};

/** Keep the beginning of a label, clipped to the allocated terminal columns. */
export function EndLabel(props: EndLabelProps) {
  const [value, textProps] = splitProps(props, ["text", "ellipsis"]);
  // A freshly mounted box has not completed native layout yet. Render its text
  // immediately and let the box clip that first frame; zero is a measured width,
  // not a placeholder. This also prevents a blank frame when scrolling remounts it.
  const [columns, setColumns] = createSignal<number>();
  return (
    <box
      flexGrow={1}
      flexShrink={1}
      minWidth={0}
      height={1}
      overflow="hidden"
      onSizeChange={function () {
        setColumns(this.width);
      }}
    >
      <text {...textProps} width="100%" height={1} wrapMode="none" truncate={false}>
        {columns() === undefined
          ? value.text
          : Bun.sliceAnsi(value.text, 0, columns(), { ellipsis: value.ellipsis ?? "…" })}
      </text>
    </box>
  );
}
