# TeamForge local MVP architecture

The existing Next.js/React/Tailwind interface, Node HTTP API, isolated Git worktrees,
Ollama coding runtime and JSON stores are retained. This is a single-company,
single-API-process local MVP, not a multi-tenant banking deployment.

## Domain and persistence

- `portfolio.json`: organization, projects, display team, phases, features, tasks,
  dependencies, acceptance criteria, proposed plans and human planning decisions.
- `state.json`: one independent Engine run per work item, four stages per run,
  revision content, hashes, reviewer decisions, execution attempts, test evidence,
  activity events and cancellation/recovery state.
- `users.json`: salted scrypt hashes, account IDs and project role memberships.
- `audit.jsonl`: authenticated HTTP writes, actor, path, status and timestamp.
- `repositories/<runId>` and `workspaces/<runId>`: private clones and Git worktrees.

JSON replacement uses an exclusive temporary file, fsync and rename. Queued
mutations roll back failed changes in memory without invalidating other operations'
entity references. Original v0.6 JSON records remain readable. Organization metadata
is added on load. These files do not form a distributed or multi-file transaction.
Use one API process per data directory and back up the entire directory together.

## Workflow

Each task owns `analysis -> backend -> frontend -> qa`. Running a stage produces
an immutable revision record and a SHA-256 digest of the accessible text workspace.
A human decision names a revision. Approval rehashes the workspace, rejects changed
content and starts only the next stage of that task. Corrections rerun the same
stage with persisted feedback. Manual edits create another revision and clear the
current check list; historical check evidence remains on prior revisions.

Per-run locks serialize start, edit, review and cancel operations. Duplicate starts
and review decisions fail without advancing a task twice. Cross-task dependencies
must name existing tasks in the same project and are enforced by the Engine.
A one-second dispatcher starts eligible real tasks and restarts interrupted real
tasks with `autoStart`; demo and manually approved planning tasks wait for Start.
Failed model requests require explicit retry. Paused and cancelled tasks do not
silently restart. A paused queued execution is checked again before inference.

The shared inference queue is FIFO among eligible projects. Admission is bounded
by inference, global execution and per-project limits. The conservative defaults
are one; tasks waiting for reviews consume no inference slot. Higher execution
limits do not bypass human gates or task dependencies.

## Runtime and sandbox

The internal agent accepts validated JSON actions for listing, reading, searching,
patching/creating/deleting files, inspecting diffs and running allowlisted checks.
Role policies are enforced in file tools. A project `filePolicy` overrides role
path defaults and is copied to each newly created run. Unknown paths are denied.
Tool failures are sent back to the model; malformed JSON has at most two retries.
The action loop is capped at 30 and automatic test repair at the configured limit.
Cancellation aborts active model requests and blocks subsequent file actions.

Inference endpoints must be loopback HTTP(S), with no URL credentials or redirects.
Prompt redaction masks common embedded tokens and password assignments in addition
to denying sensitive filenames. This is best-effort hygiene, not a DLP guarantee.

Checks execute only in Docker: unprivileged UID, no network, read-only root and
input mount, writable size-limited tmpfs, CPU/memory/PID limits and timeout. A
trusted fixed bootstrap copies the sanitized input into the container's tmpfs.
Model strings never become shell commands. Missing Docker/image/scripts produce
`skipped`, not a pass. Containers are named and removed after timeout/error.
Dependencies must be available in an administrator-prepared image. Runtime code
is never installed over the network by the agent. The legacy Codex CLI adapter
remains covered by compatibility tests but is disabled in secured HTTP execution.

## Authorization and UI

All API routes except minimal health require HTTP Basic authentication. The Next
middleware challenges page requests against `/api/session`. The API independently
validates every request. Only system administrators create accounts/projects and
assign memberships. Project managers manage structure and start/check/cancel runs;
stage reviewers have the matching project role and, when assigned, matching account
ID. Administrators can review as an explicit local MVP override. Reviewer names
come from authenticated identities, never request-supplied display names.

`/portfolio` provides hierarchy, per-task board, planning drafts, dependencies and
conflict warnings. `/` provides task execution, revision diffs, inline feedback,
manual edits, live activity, cancellation and approved patch download. `/team`
provides account creation and role assignment. SSE reconnect triggers a fresh
snapshot fetch; the server never replays a mutation on reconnect.

Overlapping edited paths in sibling tasks are reported as conflicts; this is
conservative overlap detection, not Git merge analysis. Final approved Git changes
can be exported as a patch after another hash check. No automatic merge or commit
modifies the source repository.

## Local-model latency handling

Native coding requests use a JSON action schema, a 4K model context and a smaller
analysis output budget. The transport separately bounds first-response wait
(default 180 s), inactivity between received bytes (90 s) and total response time
(600 s); the enclosing stage has a 900 s limit. Heartbeats expose elapsed request
time without model thought content. The NDJSON reader stops on done:true rather
than requiring connection closure and rejects token-limit truncation. Incomplete
actions are discarded, never executed. Saved analysis corrections become human
review candidates immediately, avoiding an additional inference to say finish.
