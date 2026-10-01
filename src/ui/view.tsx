import { For, Index, Show } from "solid-js";
import type { JSX } from "@opentui/solid";
import type { TuiDialogSelectOption, TuiPluginApi } from "@opencode-ai/plugin/tui";
import type { SidebarController } from "./controller";
import { safeLabel, statusText, type Density, type IconMode, type SidebarRow } from "./model";

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
        row.done ? "Clear completion mark" : "Mark completed",
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
      ...(["unicode", "ascii"] as const).map((value: IconMode) => ({
        title: `Icons: ${value}`,
        value: () => {
          controller.setIcons(value);
          clear();
        },
        footer: controller.icons() === value ? "Selected" : "",
      })),
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
  return {
    create,
    session,
    browse,
    settings,
    later,
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
  const attention = (row: SidebarRow) => row.summary.permissions + row.summary.questions > 0;
  const context = () => {
    const parts = props.api.state.path.directory.split(/[\\/]/).filter(Boolean);
    return safeLabel(parts.at(-1) ?? "Current project");
  };
  const symbol = (unicode: string, ascii: string) => (c.icons() === "ascii" ? ascii : unicode);
  return (
    <Show when={c.active()}>
      <box flexDirection="column" flexShrink={0} gap={0}>
        <text fg={theme().text} attributes={1}>
          Sessions
        </text>
        <box flexDirection="row" gap={2} marginBottom={c.density() === "compact" ? 0 : 1}>
          <text fg={theme().primary} onMouseUp={() => props.actions.create()}>
            New
          </text>
          <text fg={theme().primary} onMouseUp={() => props.actions.browse()}>
            Browse
          </text>
          <text fg={theme().primary} onMouseUp={() => props.actions.settings()}>
            Settings
          </text>
        </box>
        <Show when={c.density() !== "compact"}>
          <text fg={theme().textMuted} truncate wrapMode="none">
            {context()}
            {props.api.state.vcs?.branch ? ` · ${safeLabel(props.api.state.vcs!.branch!)}` : ""}
          </text>
        </Show>
        <Show when={c.connecting()}>
          <text fg={theme().textMuted}>Loading sessions…</text>
        </Show>
        <Show when={c.error()}>
          <text fg={theme().warning} wrapMode="word">
            {c.error()}
          </text>
        </Show>
        <Show
          when={c.state()?.phase === "stale" || c.state()?.phase === "error" || c.state()?.partial}
        >
          <text fg={theme().warning} wrapMode="word">
            Session data incomplete — Refresh
          </text>
        </Show>
        <Show
          when={
            c.organizationState() && c.organizationState()?.phase !== "ready" && !c.connecting()
          }
        >
          <text fg={theme().warning} wrapMode="word">
            Organization unavailable ({c.organizationState()?.phase}). Refresh or check storage.
          </text>
        </Show>
        <Index each={c.groups()}>
          {(group) => (
            <box
              flexDirection="column"
              flexShrink={0}
              marginTop={c.density() === "compact" ? 0 : 1}
            >
              <text
                fg={theme().secondary}
                attributes={1}
                onMouseUp={() => c.toggleGroup(group().id)}
              >
                {c.collapsed().has(group().id) ? symbol("▸", "+") : symbol("▾", "-")}{" "}
                {group().title} ({group().rows.length})
              </text>
              <Show when={group().rows.length > 0}>
                <text
                  fg={
                    group().summary.permissions + group().summary.questions > 0
                      ? theme().warning
                      : theme().textMuted
                  }
                  wrapMode="word"
                >
                  {statusText(group().summary, c.state()?.attentionCoverage)}
                </text>
              </Show>
              <Show when={!c.collapsed().has(group().id)}>
                <Show when={group().rows.length === 0}>
                  <text fg={theme().textMuted}>
                    {group().id === "later"
                      ? "Add sessions to read later"
                      : group().id === "pins"
                        ? "Pin sessions from their menu"
                        : "No sessions in this scope"}
                  </text>
                </Show>
                <For each={group().rows}>
                  {(row) => (
                    <box
                      flexDirection="column"
                      flexShrink={0}
                      marginBottom={c.density() === "comfortable" ? 1 : 0}
                      paddingLeft={row.session.parentId ? 1 : 0}
                      backgroundColor={
                        c.state()?.selectedSessionId === row.session.id
                          ? theme().backgroundElement
                          : theme().backgroundPanel
                      }
                      onMouseUp={() => props.actions.session(row.session.id)}
                    >
                      <text fg={theme().text} truncate wrapMode="none">
                        {row.done ? "[x]" : "[ ]"}{" "}
                        {c.state()?.selectedSessionId === row.session.id ? symbol("›", ">") : " "}{" "}
                        {safeLabel(row.session.title)}
                      </text>
                      <text
                        fg={
                          attention(row)
                            ? theme().warning
                            : row.summary.busy + row.summary.retry > 0
                              ? theme().accent
                              : theme().textMuted
                        }
                        wrapMode="word"
                      >
                        {statusText(row.summary, c.state()?.attentionCoverage)}
                      </text>
                    </box>
                  )}
                </For>
              </Show>
              <Show when={group().id === "later" && c.unavailableLater().length > 0}>
                <text fg={theme().warning} wrapMode="word" onMouseUp={() => props.actions.later()}>
                  {c.unavailableLater().length} unavailable — Manage Later
                </text>
              </Show>
            </box>
          )}
        </Index>
        <text fg={theme().textMuted} marginTop={1}>
          Select a session for actions
        </text>
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
        <text fg={props.api.theme.current.primary} onMouseUp={() => props.actions.browse()}>
          Browse sessions
        </text>
        <text fg={props.api.theme.current.primary} onMouseUp={() => props.actions.create()}>
          New session
        </text>
      </box>
    </Show>
  );
}
