import { isAbsolute } from "node:path";
import { createMemo, createSignal } from "solid-js";
import type { TuiPluginApi } from "@opencode-ai/plugin/tui";
import { createV1Adapter } from "../adapters/opencode-v1";
import type { ActionResult } from "../adapters/opencode-v1";
import { createOrganizationService, sessionIdFromKey } from "../organization";
import type { OrganizationAction } from "../organization";
import { createFileStorage } from "../storage/file";
import { createGroupBuilder, type Density, type GroupId, type IconMode } from "./model";

export interface SidebarOptions {
  readonly hostId: string;
  readonly storageDirectory: string;
  readonly workspaceId?: string;
  readonly density?: Density;
  readonly icons?: IconMode;
}

/** Storage is explicitly local; no host-reported directory becomes a local I/O path. */
export function parseSidebarOptions(input: Record<string, unknown> | undefined): SidebarOptions {
  if (
    !input ||
    typeof input.hostId !== "string" ||
    !input.hostId.trim() ||
    input.hostId.length > 512 ||
    typeof input.storageDirectory !== "string" ||
    !isAbsolute(input.storageDirectory)
  )
    throw new TypeError("Configure a stable hostId and an absolute local storageDirectory.");
  if (
    input.workspaceId !== undefined &&
    (typeof input.workspaceId !== "string" || !input.workspaceId)
  )
    throw new TypeError("workspaceId must be a nonempty string.");
  if (
    input.density !== undefined &&
    !["compact", "balanced", "comfortable"].includes(String(input.density))
  )
    throw new TypeError("density must be compact, balanced, or comfortable.");
  if (input.icons !== undefined && !["unicode", "ascii"].includes(String(input.icons)))
    throw new TypeError("icons must be unicode or ascii.");
  return {
    hostId: input.hostId,
    storageDirectory: input.storageDirectory,
    ...(input.workspaceId === undefined ? {} : { workspaceId: input.workspaceId as string }),
    ...(input.density === undefined ? {} : { density: input.density as Density }),
    ...(input.icons === undefined ? {} : { icons: input.icons as IconMode }),
  };
}

/** Owned by one Solid root. The renderer only consumes these normalized snapshots. */
export function createSidebarController(api: TuiPluginApi, options: SidebarOptions) {
  const [active, setActive] = createSignal(true);
  const [density, setDensity] = createSignal<Density>(options.density ?? "balanced");
  const [icons, setIcons] = createSignal<IconMode>(options.icons ?? "unicode");
  const [collapsed, setCollapsed] = createSignal<ReadonlySet<GroupId>>(new Set());
  const [revision, setRevision] = createSignal(0);
  const [connecting, setConnecting] = createSignal(true);
  const [error, setError] = createSignal<string | null>(null);
  const [pending, setPending] = createSignal(false);
  let adapter: ReturnType<typeof createV1Adapter> | undefined;
  let organization: ReturnType<typeof createOrganizationService> | undefined;
  let unsubscribe: (() => void) | undefined;
  let lookup: AbortController | undefined;
  let lookupInFlight = false;
  let lookupTimer: ReturnType<typeof setTimeout> | undefined;
  let epoch = 0;
  let scopeDirectory: string | undefined;
  const changed = () => setRevision((value) => value + 1);
  const buildGroups = createGroupBuilder();
  const state = createMemo(() => {
    revision();
    return adapter?.state();
  });
  const document = createMemo(() => {
    revision();
    return organization?.snapshot().document ?? null;
  });
  const organizationState = createMemo(() => {
    revision();
    return organization?.snapshot();
  });
  const groups = createMemo(() => {
    revision();
    return buildGroups(adapter?.list() ?? [], document(), (id) => adapter?.summary(id));
  });
  const rows = createMemo(() => groups().find((group) => group.id === "sessions")?.rows ?? []);
  const laterIds = createMemo(() => {
    const current = document();
    return current?.later.map((key) => sessionIdFromKey(current.scope, key)) ?? [];
  });
  const unavailableLater = createMemo(() => {
    revision();
    return laterIds().filter((id) => id !== null && !adapter?.get(id));
  });
  const unavailablePins = createMemo(() => {
    revision();
    const current = document();
    return (
      current?.pins
        .map((key) => sessionIdFromKey(current.scope, key))
        .filter((id) => !adapter?.get(id)) ?? []
    );
  });

  function notify(message: string, variant: "info" | "success" | "warning" | "error" = "info") {
    if (active()) api.ui.toast({ title: "Sessions sidebar", message, variant });
  }
  function stopScope() {
    lookup?.abort();
    lookup = undefined;
    if (lookupTimer !== undefined) clearTimeout(lookupTimer);
    lookupTimer = undefined;
    unsubscribe?.();
    unsubscribe = undefined;
    adapter?.dispose();
    organization?.dispose();
    adapter = undefined;
    organization = undefined;
  }
  async function connect(directory: string) {
    if (!active() || directory === scopeDirectory) return;
    scopeDirectory = directory;
    const generation = ++epoch;
    stopScope();
    setPending(false);
    setConnecting(true);
    setError(null);
    changed();
    if (lookupInFlight) {
      setConnecting(false);
      setError("The previous project lookup is still finishing. Refresh to retry.");
      return;
    }
    const controller = new AbortController();
    lookup = controller;
    lookupInFlight = true;
    lookupTimer = setTimeout(() => {
      if (active() && generation === epoch) {
        setError("Project lookup timed out. Refresh after the request finishes.");
        setConnecting(false);
      }
      controller.abort();
    }, 10_000);
    try {
      const response = await api.client.project.current(
        {
          directory,
          ...(options.workspaceId === undefined ? {} : { workspace: options.workspaceId }),
        },
        { signal: controller.signal },
      );
      if (generation === epoch && lookupTimer !== undefined) {
        clearTimeout(lookupTimer);
        lookupTimer = undefined;
      }
      if (!active() || generation !== epoch || controller.signal.aborted) return;
      if (!response.data) throw new Error("The host could not identify the current project.");
      const scope = {
        hostId: options.hostId,
        projectId: response.data.id,
        directory,
        ...(options.workspaceId === undefined ? {} : { workspaceId: options.workspaceId }),
      };
      adapter = createV1Adapter(api, scope);
      organization = createOrganizationService({
        scope: { hostId: scope.hostId, projectId: scope.projectId },
        storage: createFileStorage({ directory: options.storageDirectory }),
      });
      unsubscribe = adapter.subscribe(changed);
      changed();
      await Promise.all([adapter.start(), organization.start()]);
      if (!active() || generation !== epoch) return;
      changed();
    } catch {
      if (active() && generation === epoch)
        setError("Unable to load this project. Use Refresh sessions to retry.");
    } finally {
      lookupInFlight = false;
      if (generation === epoch) {
        if (lookupTimer !== undefined) clearTimeout(lookupTimer);
        lookupTimer = undefined;
        lookup = undefined;
        setConnecting(false);
      } else if (active() && scopeDirectory) {
        const directory = scopeDirectory;
        scopeDirectory = undefined;
        void connect(directory);
      }
    }
  }
  async function refresh() {
    if (!active() || pending()) return;
    if (lookupInFlight) {
      notify("The project lookup is still finishing.", "warning");
      return;
    }
    if (!adapter || !organization) {
      const directory = api.state.path.directory;
      scopeDirectory = undefined;
      if (directory) await connect(directory);
      return;
    }
    const generation = epoch;
    setPending(true);
    try {
      await Promise.all([adapter.refresh(), organization.refresh()]);
    } catch {
      if (generation === epoch)
        notify("Unable to refresh. Try again when the host is available.", "warning");
    } finally {
      if (active() && generation === epoch) {
        setPending(false);
        changed();
      }
    }
  }
  async function organize(action: OrganizationAction, expectedRevision: number) {
    if (!active() || pending() || !organization) return;
    const requiresSession =
      action.type === "add-later" ||
      (action.type === "set-pin" && action.pinned) ||
      (action.type === "set-completion" && action.done);
    if (requiresSession && "sessionId" in action && !adapter?.get(action.sessionId)) {
      notify("This session is no longer in the loaded scope.", "warning");
      return;
    }
    const service = organization;
    const generation = epoch;
    setPending(true);
    changed();
    try {
      const result = await service.dispatch({
        ...action,
        commandId: crypto.randomUUID(),
        expectedRevision,
        origin: { type: "user" },
      });
      if (!active() || generation !== epoch) return;
      if (result.status === "committed" || result.status === "noop") notify("Saved", "success");
      else
        notify(
          result.message ?? `Change ${result.status}. Refresh before trying again.`,
          "warning",
        );
    } catch {
      if (generation === epoch)
        notify("Unable to save this change. Refresh before trying again.", "error");
    } finally {
      if (active() && generation === epoch) {
        setPending(false);
        changed();
      }
    }
  }
  async function native(action: "create" | "rename" | "delete", id?: string, title?: string) {
    if (!active() || pending() || !adapter) return;
    const current = adapter;
    const generation = epoch;
    setPending(true);
    try {
      let result: ActionResult;
      if (action === "create") result = await current.create(title ?? "New session");
      else if (action === "rename" && id) result = await current.rename(id, title ?? "");
      else if (action === "delete" && id) result = await current.delete(id);
      else return;
      if (!active() || generation !== epoch) return;
      if (result.status !== "succeeded")
        notify(result.message ?? `Host operation ${result.status}`, "warning");
      else if (action === "create" && result.sessionId) current.open(result.sessionId);
      else notify(action === "delete" ? "Session deleted" : "Session renamed", "success");
    } catch {
      if (generation === epoch)
        notify(
          "The host operation could not be confirmed. Refresh before trying again.",
          "warning",
        );
    } finally {
      if (active() && generation === epoch) {
        setPending(false);
        changed();
      }
    }
  }
  function open(id: string) {
    const result = adapter?.open(id);
    if (result && result.status !== "requested")
      notify(result.message ?? "Unable to open session", "warning");
  }
  function toggleGroup(id: GroupId) {
    setCollapsed((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  function dispose() {
    if (!active()) return;
    setActive(false);
    ++epoch;
    stopScope();
    changed();
  }
  return {
    active,
    density,
    setDensity,
    icons,
    setIcons,
    collapsed,
    toggleGroup,
    state,
    document,
    organizationState,
    groups,
    rows,
    laterIds,
    unavailableLater,
    unavailablePins,
    connecting,
    error,
    pending,
    connect,
    refresh,
    organize,
    native,
    open,
    notify,
    dispose,
    guard: <Args extends unknown[]>(fn: (...args: Args) => void) => {
      const generation = epoch;
      return (...args: Args) => {
        if (active() && generation === epoch) fn(...args);
        else notify("The project changed. Reopen the session menu.", "warning");
      };
    },
    observeRoute: () => adapter?.observeRoute(),
  };
}
export type SidebarController = ReturnType<typeof createSidebarController>;
