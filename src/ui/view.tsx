import { For, Index, Show, createEffect, createSignal, onCleanup, type Accessor } from "solid-js";
import { RGBA, type Renderable } from "@opentui/core";
import { createSidebarMotion } from "./motion";
import { useTerminalDimensions, type JSX } from "@opentui/solid";
import type { TuiDialogSelectOption, TuiPluginApi } from "@opencode-ai/plugin/tui";
import type { SidebarController } from "./controller";
import {
  safeLabel,
  statusText,
  type ContextField,
  type Density,
  type IconMode,
  type SidebarRow,
} from "./model";

const contextFields = ["repository", "branch", "worktree"] as const;
const contextLabels = { repository: "Repository", branch: "Branch", worktree: "Worktree" };
const contextSymbols = { repository: "R", branch: "B", worktree: "W" };
// Details preserve the full host value while removing terminal controls and direction overrides.
const fullLabel = (value: string) =>
  value.replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/gu, " ");

type MenuOption = TuiDialogSelectOption<() => void>;

/** Mouse, palette and keyboard dialogs share the same action construction. */
export function createSidebarActions(api: TuiPluginApi, controller: SidebarController) {
  let ownsDialog = false;
  const clear = () => api.ui.dialog.clear();
  function replace(render: () => JSX.Element) {
    api.ui.dialog.replace(render, () => {
      ownsDialog = false;
    });
    ownsDialog = true;
  }
  function footer(row: SidebarRow) {
    const summary = row.summary;
    const labels = [
      summary.permissions ? `perm${summary.permissions}` : "",
      summary.questions ? `ask${summary.questions}` : "",
      summary.busy ? `busy${summary.busy}` : "",
      summary.retry ? `retry${summary.retry}` : "",
      summary.errors ? `err${summary.errors}` : "",
      summary.unknown ? `?${summary.unknown}` : "",
    ].filter(Boolean);
    if (labels.length === 0) labels.push("idle");
    if (controller.state()?.attentionCoverage !== "complete") labels.push("attn?");
    return labels.join(" ");
  }
  function select(title: string, options: () => MenuOption[]) {
    replace(() => (
      <api.ui.DialogSelect
        title={title}
        options={options()}
        onSelect={(option) => option.value()}
      />
    ));
  }
  function create() {
    if (controller.pending() || !controller.state() || controller.connecting()) {
      controller.notify(
        "Sessions are still loading or unavailable. Refresh before creating a session.",
        "warning",
      );
      return;
    }
    const confirm = controller.guard((title: string) => {
      if (!title.trim()) return;
      clear();
      void controller.native("create", undefined, title.trim());
    });
    replace(() => (
      <api.ui.DialogPrompt title="Create session" placeholder="Session title" onConfirm={confirm} />
    ));
  }
  function rename(row: SidebarRow) {
    const confirm = controller.guard((title: string) => {
      if (!title.trim()) return;
      clear();
      void controller.native("rename", row.session.id, title.trim());
    });
    replace(() => (
      <api.ui.DialogPrompt title="Rename session" value={row.session.title} onConfirm={confirm} />
    ));
  }
  function remove(row: SidebarRow) {
    const confirm = controller.guard(() => {
      void controller.native("delete", row.session.id);
    });
    replace(() => (
      <api.ui.DialogConfirm
        title="Delete session?"
        message={`Permanently delete “${safeLabel(row.session.title)}” and its messages?`}
        onConfirm={confirm}
      />
    ));
  }
  function details(id: string) {
    const row = controller.rows().find((entry) => entry.session.id === id);
    if (!row) return;
    replace(() => {
      const dimensions = useTerminalDimensions();
      return (
        <box flexDirection="column" paddingLeft={2} paddingRight={2} gap={1}>
          <text fg={api.theme.current.text} attributes={1}>
            Session details
          </text>
          <scrollbox
            id={`sidebar-session-${id}-details-scroll`}
            height={Math.max(1, dimensions().height - 12)}
            focused
          >
            <box flexDirection="column" gap={1} paddingRight={2}>
              <text fg={api.theme.current.text} wrapMode="word">
                {fullLabel(row.session.title)}
              </text>
              <text fg={api.theme.current.warning} wrapMode="word">
                {statusText(
                  controller.rows().find((entry) => entry.session.id === id)?.summary ??
                    row.summary,
                  controller.state()?.attentionCoverage,
                )}
              </text>
              <For each={contextFields}>
                {(field) => (
                  <box flexDirection="column" flexShrink={0}>
                    <text fg={api.theme.current.textMuted}>{contextLabels[field]}</text>
                    <text
                      id={`sidebar-session-${id}-details-field-${field}`}
                      fg={api.theme.current.text}
                      wrapMode="char"
                    >
                      {fullLabel(controller.context()[field] ?? "Unavailable")}
                    </text>
                  </box>
                )}
              </For>
            </box>
          </scrollbox>
          <text fg={api.theme.current.textMuted}>
            Up/Down or PgUp/PgDn to scroll · Esc to close
          </text>
        </box>
      );
    });
  }
  function sessionOptions(id: string): MenuOption[] {
    const row = controller.rows().find((entry) => entry.session.id === id);
    if (!row) return [];
    const revision = controller.document()?.revision;
    const writable =
      controller.organizationState()?.phase === "ready" &&
      revision !== undefined &&
      !controller.pending();
    const later = [...controller.laterIds()];
    const index = later.indexOf(id);
    const option = (title: string, run: () => void, disabled = false): MenuOption => ({
      title,
      value: controller.guard(run),
      disabled,
    });
    const organize = (action: Parameters<SidebarController["organize"]>[0]) => {
      clear();
      if (revision !== undefined) void controller.organize(action, revision);
    };
    const move = (delta: number) => {
      const to = index + delta;
      if (index < 0 || to < 0 || to >= later.length) return;
      [later[index], later[to]] = [later[to]!, later[index]!];
      organize({ type: "reorder-later", sessionIds: later });
    };
    return [
      option("Open session", () => {
        clear();
        controller.open(id);
      }),
      option(
        row.done ? "Unmark completed" : "Mark completed",
        () => organize({ type: "set-completion", sessionId: id, done: !row.done }),
        !writable,
      ),
      option(
        row.pinned ? "Unpin" : "Pin",
        () => organize({ type: "set-pin", sessionId: id, pinned: !row.pinned }),
        !writable,
      ),
      option(
        row.later ? "Remove from Later" : "Add to Later",
        () => organize({ type: row.later ? "remove-later" : "add-later", sessionId: id }),
        !writable,
      ),
      ...(row.later
        ? [
            option("Move earlier in Later", () => move(-1), !writable || index <= 0),
            option("Move later in Later", () => move(1), !writable || index === later.length - 1),
          ]
        : []),
      ...contextFields.map((field) =>
        option(`Context: show ${field}`, () => {
          controller.selectContext(id, field);
          clear();
        }),
      ),
      option(controller.expandedContext().has(id) ? "Collapse context" : "Expand context", () => {
        controller.toggleContext(id);
        clear();
      }),
      ...(controller.liveChildrenFor(id).length > 0
        ? [
            option(
              controller.expandedChildren().has(id) ? "Collapse subagents" : "Expand subagents",
              () => {
                controller.toggleChildren(id);
                clear();
              },
            ),
          ]
        : []),
      option("Session details", () => details(id)),
      option("Rename", () => rename(row), controller.pending()),
      option("Delete session…", () => remove(row), controller.pending()),
    ];
  }
  function session(id: string) {
    const row = controller.rows().find((entry) => entry.session.id === id);
    const options = sessionOptions(id);
    if (row)
      replace(() => (
        <box flexDirection="column">
          <text fg={api.theme.current.warning} paddingLeft={4} paddingRight={4} wrapMode="word">
            {statusText(
              controller.rows().find((entry) => entry.session.id === id)?.summary ?? row.summary,
              controller.state()?.attentionCoverage,
            )}
          </text>
          <api.ui.DialogSelect
            title={safeLabel(row.session.title)}
            options={options}
            onSelect={(option) => option.value()}
          />
        </box>
      ));
    else controller.notify("This session is no longer in the loaded scope.", "warning");
  }
  function browse() {
    // Host DialogSelect tracks an index. Freeze membership/order and callback identities
    // while it is open; activity/attention continue to update independently.
    const entries = controller
      .rows()
      .map((row) => ({ row, run: controller.guard(() => session(row.session.id)) }));
    const unavailableCreate = controller.pending() || !controller.state();
    select("Sessions sidebar", () => {
      const current = new Map(controller.rows().map((row) => [row.session.id, row]));
      return [
        {
          title: "Create session",
          value: create,
          category: "Actions",
          disabled: unavailableCreate,
        },
        { title: "Manage Later list", value: later, category: "Actions" },
        ...entries.map((entry) => {
          const row = current.get(entry.row.session.id);
          return {
            title: `${entry.row.done ? "[x] " : "[ ] "}${safeLabel(entry.row.session.title)}`,
            value: entry.run,
            category: "Sessions",
            description: row
              ? statusText(row.summary, controller.state()?.attentionCoverage)
              : "No longer in this scope",
            footer: row ? footer(row) : "unavailable",
          };
        }),
      ];
    });
  }
  function later() {
    const initial = new Map(controller.rows().map((row) => [row.session.id, row]));
    const entries = controller
      .laterIds()
      .map((id) => ({ id, title: initial.get(id)?.session.title }));
    select("Later list — manual order", () => {
      const current = new Map(controller.rows().map((row) => [row.session.id, row]));
      return entries.map(({ id, title }, index) => {
        const row = current.get(id);
        return {
          title: `${index + 1}. ${title ? safeLabel(title) : "Unavailable session"}`,
          description: row
            ? statusText(row.summary, controller.state()?.attentionCoverage)
            : "Outside this loaded scope or deleted; remove reference",
          footer: row ? footer(row) : "unavailable",
          value: controller.guard(() => {
            if (row) {
              session(id);
              return;
            }
            const revision = controller.document()?.revision;
            select("Unavailable Later reference", () => [
              {
                title: "Remove from Later",
                value: controller.guard(() => {
                  clear();
                  if (revision !== undefined)
                    void controller.organize({ type: "remove-later", sessionId: id }, revision);
                }),
                disabled: controller.pending() || controller.organizationState()?.phase !== "ready",
              },
            ]);
          }),
        };
      });
    });
  }
  function settings() {
    select("Sidebar display — this activation", () => [
      ...(["compact", "balanced", "comfortable"] as const).map((value: Density) => ({
        title: `Density: ${value}`,
        value: () => {
          controller.setDensity(value);
          clear();
        },
        footer: controller.density() === value ? "Selected" : "",
      })),
      ...(["unicode", "ascii", "nerd"] as const).map((value: IconMode) => ({
        title: `Icons: ${value}`,
        value: () => {
          controller.setIcons(value);
          clear();
        },
        footer: controller.icons() === value ? "Selected" : "",
      })),
      {
        title: `Reduced motion: ${controller.reducedMotion() ? "on" : "off"}`,
        value: () => {
          controller.setReducedMotion(!controller.reducedMotion());
          clear();
        },
      },
      ...controller.groups().map((group) => ({
        title: `${controller.collapsed().has(group.id) ? "Expand" : "Collapse"} ${group.title}`,
        value: () => {
          controller.toggleGroup(group.id);
          clear();
        },
      })),
      { title: "Manage unavailable pins", value: unavailablePins },
      {
        title: "Refresh sessions and organization",
        value: () => {
          clear();
          void controller.refresh();
        },
        disabled: controller.pending(),
      },
    ]);
  }
  function unavailablePins() {
    const revision = controller.document()?.revision;
    const entries = controller.unavailablePins();
    select("Unavailable pins — select to unpin", () =>
      entries.map((id, index) => ({
        title: `Unpin unavailable session ${index + 1}`,
        description: safeLabel(id),
        value: controller.guard(() => {
          clear();
          if (revision !== undefined)
            void controller.organize({ type: "set-pin", sessionId: id, pinned: false }, revision);
        }),
        disabled: controller.pending() || controller.organizationState()?.phase !== "ready",
      })),
    );
  }
  function quick(id: string, kind: "pin" | "later" | "completion") {
    const row = controller.rows().find((entry) => entry.session.id === id);
    const revision = controller.document()?.revision;
    if (
      !row ||
      revision === undefined ||
      controller.pending() ||
      controller.organizationState()?.phase !== "ready"
    )
      return;
    const action =
      kind === "pin"
        ? { type: "set-pin" as const, sessionId: id, pinned: !row.pinned }
        : kind === "completion"
          ? { type: "set-completion" as const, sessionId: id, done: !row.done }
          : { type: row.later ? ("remove-later" as const) : ("add-later" as const), sessionId: id };
    void controller.organize(action, revision);
  }
  function removeById(id: string) {
    const row = controller.rows().find((entry) => entry.session.id === id);
    if (row && !controller.pending()) remove(row);
  }
  function menu() {
    select("Sessions sidebar", () => [
      { title: "Browse all sessions", value: browse },
      { title: "Manage Later list", value: later },
      { title: "Display settings", value: settings },
      {
        title: "Refresh sessions and organization",
        value: () => {
          clear();
          void controller.refresh();
        },
        disabled: controller.pending(),
      },
    ]);
  }
  return {
    create,
    session,
    browse,
    settings,
    later,
    menu,
    quick,
    details,
    remove: removeById,
    disposeDialog: () => {
      if (ownsDialog) clear();
      ownsDialog = false;
    },
  };
}
export type SidebarActions = ReturnType<typeof createSidebarActions>;

export function SidebarView(props: {
  api: TuiPluginApi;
  controller: SidebarController;
  actions: SidebarActions;
}) {
  const c = props.controller;
  const theme = () => props.api.theme.current;
  const motion = createSidebarMotion(props.api.renderer);
  onCleanup(motion.dispose);
  const symbol = (unicode: string, ascii: string, nerd = unicode) =>
    c.icons() === "ascii" ? ascii : c.icons() === "nerd" ? nerd : unicode;
  // Derived from the host palette; retry stays distinct from a terminal error.
  const retryColor = () =>
    RGBA.fromValues(
      (theme().warning.r * 2 + theme().error.r) / 3,
      (theme().warning.g * 2 + theme().error.g) / 3,
      (theme().warning.b * 2 + theme().error.b) / 3,
    );
  const mutedIcon = () =>
    RGBA.fromValues(
      (theme().textMuted.r * 3 + theme().backgroundPanel.r) / 4,
      (theme().textMuted.g * 3 + theme().backgroundPanel.g) / 4,
      (theme().textMuted.b * 3 + theme().backgroundPanel.b) / 4,
    );
  const contextValue = (field: ContextField) => {
    const value = c.context()[field];
    if (!value) return "Unavailable";
    return safeLabel(
      field === "repository" ? (value.split(/[\\/]/).filter(Boolean).at(-1) ?? value) : value,
    );
  };
  const agentColor = (name?: string) => {
    const color = name && props.api.state.config.agent?.[name]?.color;
    if (!color) return theme().textMuted;
    if (/^#[0-9a-f]{6}$/i.test(color)) return color;
    if (["primary", "secondary", "accent", "error", "warning", "success", "info"].includes(color))
      return theme()[color as "primary"];
    return theme().textMuted;
  };
  const summaryLabel = (row: { summary: SidebarRow["summary"] }) => {
    const s = row.summary;
    return [
      s.permissions ? `perm${s.permissions}` : "",
      s.questions ? `ask${s.questions}` : "",
      s.busy ? `busy${s.busy}` : "",
      s.retry ? `retry${s.retry}` : "",
      s.errors ? `err${s.errors}` : "",
      s.unknown ? `unknown${s.unknown}` : "",
    ]
      .filter(Boolean)
      .join(" ");
  };
  const summaryColor = (row: { summary: SidebarRow["summary"] }) =>
    row.summary.permissions + row.summary.questions > 0
      ? theme().warning
      : row.summary.retry > 0
        ? retryColor()
        : row.summary.errors
          ? theme().error
          : theme().text;
  const age = (updatedAt: number) => {
    const minutes = Math.max(0, Math.floor((Date.now() - updatedAt) / 60_000));
    return minutes < 1
      ? "now"
      : minutes < 60
        ? `${minutes}m`
        : minutes < 1440
          ? `${Math.floor(minutes / 60)}h`
          : `${Math.floor(minutes / 1440)}d`;
  };
  const topLevel = (id: string) =>
    c.activeRow()?.session.id === id ||
    c.groups().some((group) => group.rows.some((row) => row.session.id === id));
  function SessionRow(p: { row: SidebarRow; depth?: number; active?: boolean }) {
    const row = () => p.row;
    const children = () => c.liveChildrenFor(row().session.id);
    const expanded = () => c.expandedChildren().has(row().session.id);
    const [motionGlyph, setMotionGlyph] = createSignal("");
    let statusElement: Renderable | undefined;
    const animation = motion.track({ element: () => statusElement, frame: setMotionGlyph });
    createEffect(() => {
      const s = row().summary;
      const kind =
        !c.active() || s.permissions > 0 || s.questions > 0 || s.retry > 0
          ? null
          : s.busy > 0
            ? "busy"
            : s.unknown > 0 && !s.errors && c.state()?.refreshing
              ? "checking"
              : null;
      animation.set(kind, c.icons() === "ascii", c.reducedMotion());
    });
    onCleanup(animation.dispose);
    const status = () => {
      const s = row().summary;
      if (s.permissions > 0) return { glyph: "!", color: theme().warning };
      if (s.questions > 0) return { glyph: "?", color: theme().warning };
      if (s.retry > 0) return { glyph: symbol("↻", "~"), color: retryColor() };
      if (s.busy > 0) return { glyph: motionGlyph() || symbol("⠋", "-"), color: theme().text };
      if ((s.errors ?? 0) > 0) return { glyph: symbol("×", "x"), color: theme().error };
      if (s.unknown > 0 && c.state()?.refreshing)
        return { glyph: motionGlyph() || symbol("⠤⠄", "..."), color: theme().text };
      return {
        glyph: s.unknown > 0 ? symbol("◌", "?") : symbol("·", "."),
        color: theme().text,
      };
    };
    const stop = (run: () => void) => (event: { stopPropagation(): void }) => {
      event.stopPropagation();
      run();
    };
    return (
      <box
        flexDirection="column"
        flexShrink={0}
        marginBottom={c.density() === "comfortable" ? 1 : 0}
      >
        <box
          flexDirection="column"
          flexShrink={0}
          paddingLeft={(p.depth ?? 0) > 0 && (p.depth ?? 0) <= 2 ? 1 : 0}
        >
          <box flexDirection="row" height={1} onMouseUp={() => c.open(row().session.id)}>
            <text
              id={`sidebar-session-${row().session.id}-status`}
              ref={(element) => {
                statusElement = element;
              }}
              width={3}
              flexShrink={0}
              fg={status().color}
            >
              {status().glyph}
            </text>
            <text
              fg={row().done ? theme().success : theme().text}
              flexGrow={1}
              flexShrink={1}
              minWidth={1}
              truncate
              wrapMode="none"
            >
              {safeLabel(row().session.title)}
            </text>
            <Show when={row().done}>
              <text fg={theme().success} flexShrink={0}>
                {" "}
                {symbol("✓", "+")}
              </text>
            </Show>
          </box>
          <box
            id={`sidebar-session-${row().session.id}-controls`}
            flexDirection="row"
            height={1}
            paddingLeft={3}
            gap={1}
          >
            <text
              fg={row().pinned ? theme().text : mutedIcon()}
              onMouseUp={stop(() => props.actions.quick(row().session.id, "pin"))}
            >
              {row().pinned ? symbol("◆", "P", "\uEBA0") : symbol("◇", "p", "\uEB2B")}
            </text>
            <text
              fg={row().later ? theme().text : mutedIcon()}
              onMouseUp={stop(() => props.actions.quick(row().session.id, "later"))}
            >
              {row().later ? symbol("⌛", "L", "\uF4E3") : symbol("≡", "l", "\uF451")}
            </text>
            <Show when={children().length > 0}>
              <text
                id={`sidebar-session-${row().session.id}-children-disclosure`}
                fg={theme().warning}
                flexShrink={0}
                onMouseUp={stop(() => c.toggleChildren(row().session.id))}
              >
                {expanded() ? symbol("▾", "v") : symbol("▸", ">")} {children().length}
              </text>
            </Show>
            <text
              fg={agentColor(row().session.agent)}
              flexGrow={1}
              flexShrink={1}
              minWidth={0}
              truncate
              wrapMode="none"
            >
              {row().session.agent ? `[${safeLabel(row().session.agent ?? "")}]` : ""}
            </text>
            <text fg={theme().textMuted} flexShrink={0}>
              {age(row().session.updatedAt)}
            </text>
            <text
              fg={theme().error}
              flexShrink={0}
              onMouseUp={stop(() => props.actions.remove(row().session.id))}
            >
              {symbol("⌫", "del", "\uF48E")}
            </text>
            <text
              fg={theme().textMuted}
              flexShrink={0}
              onMouseUp={stop(() => props.actions.session(row().session.id))}
            >
              {symbol("…", "...")}
            </text>
          </box>
          <Show when={children().length > 0}>
            <Show when={expanded()}>
              <For each={children()}>
                {(child) => (
                  <Show
                    when={!topLevel(child.session.id)}
                    fallback={
                      <text
                        paddingLeft={3}
                        fg={theme().textMuted}
                        truncate
                        wrapMode="none"
                        onMouseUp={() => c.open(child.session.id)}
                      >
                        {symbol("↗", ">>")} {safeLabel(child.session.title)} — shown in{" "}
                        {c.activeRow()?.session.id === child.session.id
                          ? "Active"
                          : child.later
                            ? "Later"
                            : "Pinned"}
                      </text>
                    }
                  >
                    <SessionRow row={child} depth={(p.depth ?? 0) + 1} />
                  </Show>
                )}
              </For>
            </Show>
          </Show>
          <box
            id={`sidebar-session-${row().session.id}-context`}
            flexDirection="column"
            flexShrink={0}
            paddingLeft={3}
          >
            <box flexDirection="row" height={1}>
              <text
                id={`sidebar-session-${row().session.id}-context-disclosure`}
                fg={theme().warning}
                width={2}
                flexShrink={0}
                onMouseUp={stop(() => c.toggleContext(row().session.id))}
              >
                {c.expandedContext().has(row().session.id) ? symbol("▾", "v") : symbol("▸", ">")}
              </text>
              <For each={contextFields}>
                {(field) => (
                  <text
                    id={`sidebar-session-${row().session.id}-context-select-${contextSymbols[field]}`}
                    fg={
                      c.contextField(row().session.id) === field ? theme().text : theme().textMuted
                    }
                    flexShrink={0}
                    onMouseUp={stop(() => c.selectContext(row().session.id, field))}
                  >
                    [{contextSymbols[field]}]
                  </text>
                )}
              </For>
              <text
                fg={theme().textMuted}
                flexGrow={1}
                flexShrink={1}
                minWidth={0}
                truncate
                wrapMode="none"
                onMouseUp={stop(() => props.actions.details(row().session.id))}
              >
                {" "}
                {contextValue(c.contextField(row().session.id))}
              </text>
            </box>
            <Show when={c.expandedContext().has(row().session.id)}>
              <box
                id={`sidebar-session-${row().session.id}-context-details`}
                flexDirection="column"
                flexShrink={0}
              >
                <For each={contextFields}>
                  {(field) => (
                    <box flexDirection="row" height={1} paddingLeft={2}>
                      <text fg={theme().textMuted} flexShrink={0}>
                        [{contextSymbols[field]}]{" "}
                      </text>
                      <text
                        fg={theme().textMuted}
                        flexGrow={1}
                        flexShrink={1}
                        minWidth={0}
                        truncate
                        wrapMode="none"
                        onMouseUp={stop(() => props.actions.details(row().session.id))}
                      >
                        {contextValue(field)}
                      </text>
                    </box>
                  )}
                </For>
              </box>
            </Show>
          </box>
          <Show when={p.active}>
            <text
              id={`sidebar-session-${row().session.id}-completion`}
              fg={theme().warning}
              paddingLeft={3}
              onMouseUp={() => props.actions.quick(row().session.id, "completion")}
            >
              {row().done ? "Unmark completed" : "Mark completed"}
            </text>
          </Show>
        </box>
      </box>
    );
  }
  return (
    <Show when={c.active()}>
      <box flexDirection="column" flexShrink={0} gap={0}>
        <box flexDirection="row" height={1}>
          <text fg={theme().text} attributes={1} flexGrow={1}>
            Active session:
          </text>
          <text fg={theme().textMuted} onMouseUp={() => props.actions.menu()}>
            {symbol("…", "...")}
          </text>
        </box>
        <text fg={theme().warning} onMouseUp={() => props.actions.create()}>
          new session +
        </text>
        <Show
          when={c.activeRow()}
          fallback={
            <text fg={theme().textMuted}>
              {c.connecting() ? "Loading sessions…" : "No active session"}
            </text>
          }
        >
          {(row: Accessor<SidebarRow>) => <SessionRow row={row()} active />}
        </Show>
        <Show when={c.error()}>
          <text fg={theme().warning} wrapMode="word">
            {c.error()}
          </text>
        </Show>
        <Show
          when={c.state()?.phase === "stale" || c.state()?.phase === "error" || c.state()?.partial}
        >
          <text fg={theme().warning} wrapMode="word" onMouseUp={() => void c.refresh()}>
            Session data incomplete — Refresh
          </text>
        </Show>
        <Show
          when={
            c.organizationState() && c.organizationState()?.phase !== "ready" && !c.connecting()
          }
        >
          <text fg={theme().warning} wrapMode="word" onMouseUp={() => void c.refresh()}>
            Organization unavailable — Refresh
          </text>
        </Show>
        <Index each={c.groups()}>
          {(group) => (
            <box
              flexDirection="column"
              flexShrink={0}
              marginTop={c.density() === "compact" ? 0 : 1}
            >
              <box flexDirection="row" height={1} onMouseUp={() => c.toggleGroup(group().id)}>
                <text
                  fg={theme().text}
                  attributes={1}
                  flexGrow={1}
                  flexShrink={1}
                  truncate
                  wrapMode="none"
                >
                  {c.collapsed().has(group().id) ? symbol("▸", ">") : symbol("▾", "v")}{" "}
                  {group().title}
                </text>
              </box>
              <Show when={c.collapsed().has(group().id) && summaryLabel(group())}>
                <text fg={summaryColor(group())} paddingLeft={2} wrapMode="word">
                  {summaryLabel(group())}
                </text>
              </Show>
              <Show when={!c.collapsed().has(group().id)}>
                <For each={group().rows}>{(row) => <SessionRow row={row} />}</For>
              </Show>
              <Show when={group().id === "later" && c.unavailableLater().length > 0}>
                <text fg={theme().warning} wrapMode="word" onMouseUp={() => props.actions.later()}>
                  {c.unavailableLater().length} unavailable — Manage Later
                </text>
              </Show>
            </box>
          )}
        </Index>
      </box>
    </Show>
  );
}

export function SidebarHome(props: {
  api: TuiPluginApi;
  controller: SidebarController;
  actions: SidebarActions;
}) {
  return (
    <Show when={props.controller.active()}>
      <box flexDirection="row" gap={2}>
        <text fg={props.api.theme.current.warning} onMouseUp={() => props.actions.browse()}>
          Browse sessions
        </text>
        <text fg={props.api.theme.current.warning} onMouseUp={() => props.actions.create()}>
          new session +
        </text>
      </box>
    </Show>
  );
}
