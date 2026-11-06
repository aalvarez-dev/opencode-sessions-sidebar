/**
 * Optional committed-event observer. Enabling this module opts into its notices.
 * @satisfies {import('../dist/extensions/index.js').SidebarExtension}
 */
export default {
  apiVersion: 1,
  id: "completion-observer",
  onEvent(event, context) {
    if (event.type === "session.completion.changed" && event.after) {
      context.notify("Completion mark saved. No workflow was started.");
    }
  },
};
