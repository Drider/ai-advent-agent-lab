# Task workflow implementation continuation

Updated: 2026-11-21

## Current point

- Branch: `codex/task-workflows`
- Remote: `origin/codex/task-workflows`
- Current commit: `5a737f0`
- Worktree is clean.
- Tasks 1–9 are implemented, reviewed, and pushed. Task 10 has not changed code; its delegated implementation stopped at the usage limit.

## Completed commits

1. `95958d5` — contracts and workflow parser
2. `2a4dd56` — persistence schema and repositories
3. `3b17d1c` — task lifecycle and transactional commands
4. `08cbc9a` — workflow transitions, artifacts, approvals
5. `8ecf997` — checks, templates, startup seeding
6. `100ba43` — tool policy, intent, recovery
7. `dbc9cfb` — runtime context and live agent tools
8. `fdf4833` — trusted task controls, workflow API, profile default
9. `5a737f0` — task UI plus resume/profile race fixes

Task 9's final fix review accepted all findings. Its verification included 479 full-suite tests, typecheck, build, and browser scenarios for delayed resume, lost accepted responses, and preserving unsaved profile instructions.

## Resume from Task 10

Read the detailed brief at `.superpowers/sdd/2026-11-20-task-workflows/task-10-brief.md` and the plan's Task 10 section. Implement `server/tasks/cleanup.ts` and integrate it with the existing clear/branch/session repositories.

Required behavior:

- `assertTaskSessionQuiescent(db, sessionId)` and `clearSessionTaskData(db, sessionId)` run inside the existing clear transaction before messages/turns are removed.
- Block cleanup for running turns, running or uncertain operations, pending log cleanup, and unresolved recovery state.
- Before deleting task commands, tombstone every command `operationId` and every unconsumed `resumeRequestId` in `cleared_requests`. The latter is required for older clients that do not send `resumeTaskId`.
- Delete task-owned tasks, artifacts, events, commands, approvals, validations, operations, and exported-context bindings. Keep standalone memory and external files.
- Branches copy conversation context only. They must not inherit unfinished tasks, approvals, validations, task exports, or task authority. Copied tool parts are not evidence.
- Backups/reopen preserve paused tasks and valid continuation. Legacy interrupted responses continue without synthetic tasks or approvals.
- Context exports remain allowlisted, completed-task, same-dialogue data and never become authority in another branch/project.

Required test set:

`tests/task-dialogue-lifecycle.test.ts tests/branch-repository.test.ts tests/memory-clear.test.ts tests/memory-clear-recovery.test.ts tests/chat-backup.test.ts`

Then run the related regressions, `npm run typecheck`, and the full test suite. Commit as:

`fix: isolate task state across dialogue lifecycle`

After the commit, create a review package against `5a737f0`, dispatch a fresh reviewer, and use the documented fix loop for any Important/Critical findings.

## Task 11 after Task 10

Task 11 adds real-path acceptance tests and documentation. Cover analytics, optional questionnaire, code planning/approval, malicious skip attempts, pause/resume on each node, SQLite reopen, no-workflow dialogs, and formal validation. Update the user/developer docs and manual test scenario. Run `npm run typecheck`, `npm test`, `npm run build`, and the manual scenario. Keep workflow generation and visual graph/editor deferred.

Finally perform the whole-branch review, triage the deferred minor findings, rerun final gates, and only then wrap up the branch. Do not merge or push to another branch without explicit direction.

## Deferred minor findings for final review

- Task 3: `TaskView` may advertise resume while a session has a running turn.
- Task 4: validation result recency previously used wall-clock ordering.
- Task 7: existing `context-compaction/prepare.ts` is unchanged because overhead enters through the chat route.
- Task 8: JSON bodies are buffered before size limits.
- Task 9: successful task refresh leaves a prior read error visible.

## Invariants to preserve

- One unfinished task per dialogue; paused still occupies the slot.
- Workflows and questionnaires are optional and user-selected; no workflow is inferred by default.
- Transitions and approvals are checked in code before mutation.
- Old chat, memory, copied tool parts, and approvals are context only unless current task-owned evidence authorizes them.
- Live tools use the immutable actor captured for their prepared step.
- UI retries preserve `expectedTaskId`, `expectedRevision`, and `operationId`.
- A resume request is tied to its source task; cleanup tombstones its request ID before deleting its receipt.
