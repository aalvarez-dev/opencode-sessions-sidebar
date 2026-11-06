/**
 * Trusted local example: no model calls, native history reads, files, or network.
 * Configure this file explicitly in sidebar options; it is never auto-discovered.
 * @satisfies {import('../dist/extensions/index.js').SidebarExtension}
 */
export default {
  apiVersion: 1,
  id: "report-preview",
  actions: [
    {
      id: "summary",
      title: "Preview session summary",
      run(context) {
        if (!context.session) return;
        const { session, organization, scope } = context;
        const key = JSON.stringify([scope.hostId, scope.projectId, session.id]);
        const done =
          organization.completionStates.find((state) => state.sessionKey === key)?.done ?? false;
        context.notify(
          `${session.title}: ${session.activity}; completed=${done}; pinned=${organization.pins.includes(key)}; later=${organization.later.includes(key)}`,
        );
      },
    },
  ],
};
