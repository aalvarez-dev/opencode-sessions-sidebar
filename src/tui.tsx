import { createEffect, createRoot } from "solid-js";
import type { TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui";
import { createSidebarController, parseSidebarOptions, type SidebarOptions } from "./ui/controller";
import { createSidebarActions, SidebarHome, SidebarView } from "./ui/view";

export type { SidebarOptions };
/** Experimental local plugin entrypoint; all UI runtimes remain host-provided. */
function activateSidebar(api: TuiPluginApi, options: SidebarOptions): void {
  const checked = parseSidebarOptions({ ...options });
  createRoot((disposeRoot) => {
    const controller = createSidebarController(api, checked);
    const actions = createSidebarActions(api, controller);
    let disposed = false;
    const unregisterCommands = api.keymap.registerLayer({
      mode: "base",
      commands: [
        {
          name: "sessions-sidebar.browse",
          title: "Sessions sidebar: browse",
          namespace: "palette",
          category: "Sessions sidebar",
          run: actions.browse,
        },
        {
          name: "sessions-sidebar.create",
          title: "Sessions sidebar: create session",
          namespace: "palette",
          category: "Sessions sidebar",
          run: actions.create,
        },
        {
          name: "sessions-sidebar.refresh",
          title: "Sessions sidebar: refresh",
          namespace: "palette",
          category: "Sessions sidebar",
          run: () => {
            void controller.refresh();
          },
        },
        {
          name: "sessions-sidebar.settings",
          title: "Sessions sidebar: settings",
          namespace: "palette",
          category: "Sessions sidebar",
          run: actions.settings,
        },
      ],
    });
    api.slots.register({
      order: 350,
      slots: {
        sidebar_content: () => <SidebarView api={api} controller={controller} actions={actions} />,
        home_bottom: () => <SidebarHome api={api} controller={controller} actions={actions} />,
      },
    });
    createEffect(() => {
      const directory = api.state.path.directory;
      if (api.state.ready && directory) {
        actions.disposeDialog();
        void controller.connect(directory);
      }
    });
    createEffect(() => {
      // Track route fields even before asynchronous connection creates the adapter.
      // The host may update a stable reactive route object in place.
      const route = api.route.current;
      if (route.name === "session") route.params?.sessionID;
      controller.observeRoute();
    });
    let removeLifecycle = () => {};
    function dispose() {
      if (disposed) return;
      disposed = true;
      actions.disposeDialog();
      controller.dispose();
      unregisterCommands();
      removeLifecycle();
      disposeRoot();
    }
    removeLifecycle = api.lifecycle.onDispose(dispose);
  });
}

export default {
  id: "opencode-sessions-sidebar",
  async tui(api, options) {
    try {
      activateSidebar(api, parseSidebarOptions(options));
    } catch (error) {
      api.ui.toast({
        title: "Sessions sidebar configuration",
        message: error instanceof Error ? error.message : "Unable to activate the sidebar.",
        variant: "error",
        duration: 10_000,
      });
    }
  },
} satisfies TuiPluginModule;
