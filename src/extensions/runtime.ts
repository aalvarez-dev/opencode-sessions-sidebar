import { fileURLToPath } from "node:url";
import { isAbsolute } from "node:path";
import type {
  createOrganizationService,
  OrganizationAction,
  OrganizationResult,
} from "../organization";
import type {
  ExtensionActionEntry,
  ExtensionContext,
  ExtensionDiagnostic,
  ExtensionSession,
  ExtensionSnapshot,
  SidebarExtension,
  SidebarExtensionAction,
  SidebarExtensionConfig,
} from "./types";

const MAX_EXTENSIONS = 8;
const MAX_ACTIONS = 16;
const ID = /^[a-z][a-z0-9-]{0,63}$/;
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/u;

/** Error kinds/codes are useful without exposing a module's message, paths or stack. */
function errorKind(error: unknown): string {
  try {
    if (!error || typeof error !== "object") return "unknown error";
    const candidate = error as { name?: unknown; code?: unknown };
    const name =
      typeof candidate.name === "string" && /^[A-Za-z][A-Za-z0-9]{0,39}$/.test(candidate.name)
        ? candidate.name
        : "Error";
    const code =
      typeof candidate.code === "string" && /^[A-Z][A-Z0-9_]{0,47}$/.test(candidate.code)
        ? `, ${candidate.code}`
        : "";
    return name + code;
  } catch {
    return "uninspectable error";
  }
}

export function parseExtensionConfigs(input: unknown): readonly SidebarExtensionConfig[] {
  if (input === undefined) return Object.freeze([]);
  if (!Array.isArray(input) || input.length > MAX_EXTENSIONS)
    throw new TypeError("extensions must contain at most eight explicit local module entries.");
  const seen = new Set<string>();
  return Object.freeze(
    input.map((entry: unknown) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry))
        throw new TypeError("Each extension requires a local file URL in module.");
      const value = entry as Record<string, unknown>;
      if (
        typeof value.module !== "string" ||
        value.module.length > 4096 ||
        (value.enabled !== undefined && typeof value.enabled !== "boolean")
      )
        throw new TypeError("An extension needs module and an optional boolean enabled.");
      let url: URL;
      try {
        url = new URL(value.module);
        if (
          url.protocol !== "file:" ||
          url.hostname ||
          url.search ||
          url.hash ||
          !isAbsolute(fileURLToPath(url)) ||
          !/\.(?:mjs|js)$/i.test(url.pathname)
        )
          throw new Error();
      } catch {
        throw new TypeError(
          "Extension modules must be absolute local file: URLs ending in .mjs or .js.",
        );
      }
      if (seen.has(url.href)) throw new TypeError("Duplicate extension module.");
      seen.add(url.href);
      return Object.freeze({
        module: url.href,
        ...(value.enabled === undefined ? {} : { enabled: value.enabled }),
      });
    }),
  );
}

function manifest(input: unknown): SidebarExtension {
  if (!input || typeof input !== "object") throw new TypeError("Missing extension default export.");
  const value = input as SidebarExtension;
  if (value.apiVersion !== 1 || typeof value.id !== "string" || !ID.test(value.id))
    throw new TypeError("Unsupported extension API or invalid extension ID.");
  if (value.onEvent !== undefined && typeof value.onEvent !== "function")
    throw new TypeError("onEvent must be a function.");
  if (
    value.actions !== undefined &&
    (!Array.isArray(value.actions) || value.actions.length > MAX_ACTIONS)
  )
    throw new TypeError("An extension can register at most sixteen actions.");
  const ids = new Set<string>();
  const actions = (value.actions ?? []).map((action) => {
    if (
      !action ||
      typeof action.id !== "string" ||
      !ID.test(action.id) ||
      ids.has(action.id) ||
      typeof action.title !== "string" ||
      !action.title.trim() ||
      action.title.length > 100 ||
      CONTROL.test(action.title) ||
      typeof action.run !== "function" ||
      (action.visible !== undefined && typeof action.visible !== "function") ||
      (action.enabled !== undefined && typeof action.enabled !== "function")
    )
      throw new TypeError("Invalid or duplicate extension action.");
    ids.add(action.id);
    return Object.freeze({
      id: action.id,
      title: action.title,
      run: action.run,
      ...(action.visible === undefined ? {} : { visible: action.visible }),
      ...(action.enabled === undefined ? {} : { enabled: action.enabled }),
    });
  });
  return Object.freeze({
    apiVersion: 1,
    id: value.id,
    actions: Object.freeze(actions),
    ...(value.onEvent === undefined ? {} : { onEvent: value.onEvent }),
  });
}

type Service = ReturnType<typeof createOrganizationService>;
interface Binding {
  readonly service: Service;
  readonly session: (id: string) => ExtensionSession | undefined;
}
interface Entry {
  readonly module: string;
  state: ExtensionDiagnostic["state"];
  message: string | null;
  definition?: SidebarExtension;
  unsubscribe?: () => void;
}
export interface ExtensionRuntimeOptions {
  readonly configs: readonly SidebarExtensionConfig[];
  readonly changed: () => void;
  readonly notify: (message: string, failed?: boolean) => void;
  /** For deterministic tests; normal loading uses dynamic import of the validated file URL. */
  readonly importer?: (url: string) => Promise<{ default?: unknown }>;
  readonly timeoutMs?: number;
}

/** One activation owns module loads and callback reservations across every project scope. */
export function createExtensionRuntime(options: ExtensionRuntimeOptions) {
  const entries: Entry[] = parseExtensionConfigs(options.configs).map((config) => ({
    module: config.module,
    state: config.enabled === false ? "disabled" : "loading",
    message: null,
  }));
  const timeoutMs = options.timeoutMs ?? 5_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000)
    throw new RangeError("Invalid extension timeout.");
  let binding: Binding | undefined;
  let generation = 0;
  let disposed = false;
  let started: Promise<void> | undefined;
  let imports = 0;
  const operations = new Map<AbortController, Entry>();
  const reservations = new Set<AbortController>();
  const cancelImports = new Set<() => void>();
  const notifyChanged = () => {
    if (!disposed) options.changed();
  };
  function fail(entry: Entry, message: string) {
    if (disposed || entry.state === "failed") return;
    entry.state = "failed";
    entry.message = message;
    entry.unsubscribe?.();
    delete entry.unsubscribe;
    for (const [controller, owner] of operations) if (owner === entry) controller.abort();
    options.notify(`Extension ${entry.definition?.id ?? "module"}: ${message}`, true);
    notifyChanged();
  }
  function snapshot(current: Binding, sessionId?: string): ExtensionSnapshot | undefined {
    const state = current.service.snapshot();
    if (state.phase !== "ready" || !state.document) return;
    const session = sessionId === undefined ? null : current.session(sessionId);
    if (sessionId !== undefined && !session) return;
    return Object.freeze({
      scope: state.document.scope,
      organization: state.document,
      session: session ? Object.freeze({ ...session }) : null,
    });
  }
  function predicate(action: SidebarExtensionAction, state: ExtensionSnapshot) {
    const boolean = (value: unknown): boolean => {
      if (typeof value === "boolean") return value;
      // A mistakenly async predicate must not leave an unhandled rejection in the host.
      // It is never awaited or retried; the enclosing failure disables the extension.
      void Promise.resolve(value).catch(() => undefined);
      throw new TypeError("Action predicates must return booleans synchronously.");
    };
    const visible = action.visible ? boolean(action.visible(state)) : true;
    const enabled = visible && action.enabled ? boolean(action.enabled(state)) : visible;
    return { visible, enabled };
  }
  async function invoke(
    entry: Entry,
    state: ExtensionSnapshot,
    run: (context: ExtensionContext) => void | Promise<void>,
    outer?: AbortSignal,
    expectedRevision = state.organization.revision,
  ): Promise<boolean> {
    const current = binding;
    if (
      !current ||
      disposed ||
      entry.state !== "ready" ||
      outer?.aborted ||
      reservations.size >= MAX_EXTENSIONS
    )
      return false;
    const epoch = generation;
    let revision = expectedRevision;
    const controller = new AbortController();
    operations.set(controller, entry);
    reservations.add(controller);
    let finish!: (result: boolean) => void;
    const stopped = new Promise<boolean>((resolve) => {
      finish = resolve;
    });
    let completed = false;
    const abort = () => {
      if (
        !disposed &&
        binding === current &&
        generation === epoch &&
        !completed &&
        !controller.signal.aborted
      )
        fail(entry, "Listener ended before its callback settled and was disabled.");
      controller.abort();
      finish(false);
    };
    outer?.addEventListener("abort", abort, { once: true });
    controller.signal.addEventListener("abort", () => finish(completed), { once: true });
    const timer = setTimeout(() => {
      fail(entry, "Callback timed out and was disabled.");
      abort();
    }, timeoutMs);
    const authorized = () =>
      !disposed &&
      binding === current &&
      generation === epoch &&
      entry.state === "ready" &&
      !controller.signal.aborted;
    const result = (status: OrganizationResult["status"], message: string): OrganizationResult => ({
      status,
      revision: current.service.snapshot().document?.revision ?? null,
      message,
    });
    const context: ExtensionContext = Object.freeze({
      ...state,
      signal: controller.signal,
      expectedRevision,
      async dispatch(action: OrganizationAction) {
        if (!authorized()) return result("unavailable", "Extension callback is no longer active.");
        if (!action || typeof action !== "object" || "executionSequence" in action)
          return result("invalid", "Extensions cannot supply host execution evidence.");
        if ("sessionId" in action && !current.session(action.sessionId))
          return result("unavailable", "Session is outside the loaded scope.");
        const outcome = await current.service.dispatch(
          {
            ...action,
            commandId: crypto.randomUUID(),
            expectedRevision: revision,
            origin: { type: "extension", id: entry.definition!.id },
          },
          controller.signal,
        );
        if (authorized()) {
          if (
            (outcome.status === "committed" || outcome.status === "noop") &&
            outcome.revision !== null
          )
            revision = outcome.revision;
          notifyChanged();
        }
        return outcome;
      },
      notify(message: string) {
        if (authorized() && typeof message === "string")
          options.notify(message.replace(new RegExp(CONTROL.source, "gu"), " ").slice(0, 500));
      },
    });
    const work = Promise.resolve()
      .then(() => {
        if (!authorized()) return false;
        try {
          const pending = run(context);
          // Revoke in the callback's own completion turn so detached commands cannot race cleanup.
          if (pending === undefined) {
            completed = true;
            controller.abort();
            return true;
          }
          return Promise.resolve(pending).then(() => {
            completed = true;
            controller.abort();
            return true;
          });
        } catch (error) {
          throw error;
        }
      })
      .catch((error: unknown) => {
        if (authorized()) fail(entry, `Callback failed (${errorKind(error)}) and was disabled.`);
        controller.abort();
        return false;
      })
      .finally(() => {
        reservations.delete(controller);
        notifyChanged();
      });
    try {
      // Callback completion aborts authority too; its success is not needed to establish a write.
      return await Promise.race([work, stopped]);
    } finally {
      clearTimeout(timer);
      outer?.removeEventListener("abort", abort);
      operations.delete(controller);
      controller.abort();
    }
  }
  function subscribe(entry: Entry) {
    entry.unsubscribe?.();
    delete entry.unsubscribe;
    const current = binding;
    const handler = entry.definition?.onEvent;
    if (!current || entry.state !== "ready" || !handler) return;
    entry.unsubscribe = current.service.subscribe(
      `sidebar:${entry.definition!.id}`,
      async (event, listener) => {
        const state = snapshot(current, event.sessionId);
        if (binding !== current || !state) return;
        // Observers still receive the event; its command authority never advances to a later edit.
        await invoke(
          entry,
          state,
          (context) => handler(event, context),
          listener.signal,
          event.revision,
        );
      },
    );
  }
  async function load(entry: Entry) {
    if (entry.state !== "loading" || disposed) return;
    imports++;
    let timeout!: ReturnType<typeof setTimeout>;
    let cancel!: () => void;
    const cancelled = new Promise<undefined>((resolve) => {
      cancel = () => resolve(undefined);
      cancelImports.add(cancel);
      timeout = setTimeout(() => {
        fail(entry, "Module loading timed out.");
        resolve(undefined);
      }, timeoutMs);
    });
    const imported = Promise.resolve()
      .then(() => {
        if (disposed || entry.state !== "loading") return;
        return (options.importer ?? ((url: string) => import(url)))(entry.module);
      })
      .then((value) => {
        if (disposed || entry.state !== "loading") return;
        const definition = manifest(value?.default);
        if (entries.some((other) => other !== entry && other.definition?.id === definition.id))
          throw new TypeError("Duplicate extension ID.");
        entry.definition = definition;
        entry.state = "ready";
        subscribe(entry);
        notifyChanged();
      })
      .catch((error: unknown) =>
        fail(entry, `Unable to load a valid version-1 local module (${errorKind(error)}).`),
      )
      .finally(() => {
        imports--;
      });
    await Promise.race([imported, cancelled]);
    clearTimeout(timeout);
    cancelImports.delete(cancel);
  }
  function start() {
    return (started ??= Promise.all(entries.map(load)).then(() => undefined));
  }
  function detach() {
    generation++;
    binding = undefined;
    for (const entry of entries) {
      entry.unsubscribe?.();
      delete entry.unsubscribe;
    }
    for (const controller of operations.keys()) controller.abort();
    notifyChanged();
  }
  function attach(service: Service, session: Binding["session"]) {
    detach();
    if (disposed) return;
    binding = { service, session };
    for (const entry of entries) subscribe(entry);
    void start();
  }
  function actions(sessionId: string): readonly ExtensionActionEntry[] {
    if (!binding || disposed) return [];
    const state = snapshot(binding, sessionId);
    if (!state) return [];
    return entries.flatMap((entry) => {
      if (entry.state !== "ready" || !entry.definition) return [];
      try {
        return (entry.definition.actions ?? []).flatMap((action) => {
          const visibility = predicate(action, state);
          return visibility.visible
            ? [
                {
                  id: `${entry.definition!.id}:${action.id}`,
                  title: action.title,
                  extensionId: entry.definition!.id,
                  enabled: visibility.enabled && reservations.size < MAX_EXTENSIONS,
                },
              ]
            : [];
        });
      } catch {
        fail(entry, "Action predicate failed and was disabled.");
        return [];
      }
    });
  }
  async function run(id: string, sessionId: string) {
    if (!binding || disposed) return false;
    const state = snapshot(binding, sessionId);
    if (!state) return false;
    const entry = entries.find((candidate) => candidate.definition?.id === id.split(":")[0]);
    const action = entry?.definition?.actions?.find(
      (candidate) => `${entry.definition!.id}:${candidate.id}` === id,
    );
    if (!entry || entry.state !== "ready" || !action) return false;
    try {
      const allowed = predicate(action, state);
      if (!allowed.visible || !allowed.enabled) return false;
    } catch {
      fail(entry, "Action predicate failed and was disabled.");
      return false;
    }
    return invoke(entry, state, action.run);
  }
  return {
    start,
    attach,
    detach,
    actions,
    run,
    diagnostics: (): readonly ExtensionDiagnostic[] =>
      entries.map((entry) =>
        Object.freeze({
          module: entry.module,
          id: entry.definition?.id ?? null,
          state: entry.state,
          message: entry.message,
        }),
      ),
    pending: () => ({ imports, callbacks: reservations.size }),
    dispose() {
      if (disposed) return;
      disposed = true;
      detach();
      for (const cancel of cancelImports) cancel();
    },
  };
}
