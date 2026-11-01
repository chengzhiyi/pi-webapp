# GitHub plugin: workbench redesign (proposal)

Status: proposal. Replaces the "issue-processing bot" framing in `pi-extensions/packages/github/docs/DESIGN.md`.
Inspiration: Orca (stablyai/orca): Tasks drawer, issue -> worktree -> agent, PR tab, checks panel, "Fix broken checks".

## Product statement
A workbench for the GitHub repo the current workspace already lives in. It answers three questions without leaving the app:
1. What should I work on? (issues, PRs)
2. Hand it to an agent (with the right context and mode).
3. Is my PR healthy, and what does the agent do next? (checks, reviews, merge)

The existing plan -> approve -> execute -> PR pipeline stays, as one start mode.

## Principles
- Zero config: repo comes from the workspace `origin`; auth is the existing device flow. No trusted authors / labels needed to see value.
- Human gates stay: the agent never merges; execute still needs the host approval prompt. Issue/comment text stays untrusted data.
- Pull-based (no webhook): refresh on panel open, manual refresh, and a slow poll only for items with a live task.

## Surfaces

### 1. Tasks (home)
One list: open issues, PRs requesting my review, my PRs. Filters: assigned to me, label, state; search. Row shows linked task state if one exists. Persisted view settings.

### 2. Start with agent (issue or PR row)
Composer: title, branch name (default `agent/issue-N`), and mode:
- Plan first: read-only plan, approve, then execute (today's flow).
- Go directly: execute after the host approval prompt.
Prompt context includes issue body and comments (untrusted, fenced). Creates branch + session linked to the issue.

### 3. PR view
Status, checks (failed jobs with log excerpt), reviews and threaded comments. Actions:
- Fix failing checks -> sends failed check names + links to the session.
- Address review comments -> sends selected comments to the session.
- Mark ready for review; Merge (hidden for draft/conflicting/failing; user-initiated only).

### 4. Linking
Session shows linked issue / branch / PR. Posting status comments on the issue becomes optional (off by default).

### 5. Autopilot (advanced, off by default)
Existing polling triggers: assignee/label pickup, trusted authors, claim label, maxActive.

## Phases
1. Tasks list + Start with agent (modes) + linking. Needs: list issues/PRs REST calls, composer UI.
2. PR view: checks, reviews, mark ready, merge. Needs: checks/reviews REST, actions.
3. Fix-checks / address-comments agent actions; log excerpts.
4. Move existing board behind Autopilot.

## Open questions
- Linear/GitLab: out of scope for now?
- Worktree per task vs. branch in the current checkout? (host capability needed for worktrees)
- Are PRs from other people in scope (review requests), or only mine?
