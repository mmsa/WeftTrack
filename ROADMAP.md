# WeftTrack roadmap

WeftTrack currently supports a delivery board, workflow transitions, a relationship map, and a code-change registry. Work items and external changes have stable identities. Directed links represent hierarchy, dependencies, and implementation.

## Planned capabilities

1. **Workspaces and access.** Add projects, work item types, accounts, and roles. Apply visibility checks to both endpoints of every relationship.
2. **Work item history.** Record edits, assignments, status changes, and links. Add comments, mentions, and attachments.
3. **Workflow configuration.** Support reusable workflow definitions, transition guards, completion outcomes, and reopening paths.
4. **Planning and reporting.** Add ordered backlogs, sprints, milestones, saved filters, and reports derived from workflow history.
5. **Automation and integration.** Add scoped event rules and authenticated delivery from companion services. Preserve linked records across repository renames and deduplicate incoming events.

For a SaaS export launch, an epic would contain the export story and QA tasks. An open defect could block the release, and a linked pull request would show which code implements the story. The same relationships would feed the board and release reports.
