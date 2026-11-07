import { createSignal, splitProps } from "solid-js";
import type { JSX } from "@opentui/solid";

export type EndLabelProps = Omit<JSX.IntrinsicElements["text"], "children"> & {
  text: string;
  ellipsis?: string;
};

/** Keep the beginning of a label, clipped to the allocated terminal columns. */
export function EndLabel(props: EndLabelProps) {
  const [value, textProps] = splitProps(props, ["text", "ellipsis"]);
  const [columns, setColumns] = createSignal(0);
  return (
    <box
      flexGrow={1}
      flexShrink={1}
      minWidth={0}
      height={1}
      overflow="hidden"
      ref={(element) => setColumns(element.width)}
      onSizeChange={function () {
        setColumns(this.width);
      }}
    >
      <text {...textProps} width="100%" height={1} wrapMode="none" truncate={false}>
        {Bun.sliceAnsi(value.text, 0, columns(), { ellipsis: value.ellipsis ?? "…" })}
      </text>
    </box>
  );
}
