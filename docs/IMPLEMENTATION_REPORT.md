# TeamForge implementation and validation report

Validated on 2026-10-17, Asia/Shanghai, macOS. Baseline: supplied v0.6.0-real folder.
The folder has no `.git` metadata, so changes are delivered directly in the
workspace rather than as a commit or pull request. Existing data was retained.

## Audit findings and implemented changes

The baseline already had independent work-item Engine runs, local Git clones and
worktrees, a multi-step Ollama runtime, role-based write path checks, Docker command
execution, live progress, persisted JSON, review feedback and a four-lane portfolio.
These capabilities were extended rather than replacing the app.

The major original gaps were unauthenticated writes and display-only memberships,
reviews not tied to a checked content snapshot, races around concurrent starts and
reviews, missing task dependencies/planning approval, weak persistence failure
handling and unauthenticated smoke scripts. The implementation adds:

- Salted scrypt account credentials, first-run random bootstrap, Basic authentication
  in Next middleware and independently on the API, project role memberships,
  assigned reviewer account checks, server-derived reviewer identity, write Origin
  checks, failed-login rate limits and authenticated HTTP write audit records.
- `/team` account creation/membership UI and a local password-reset command.
  Existing display names remain display-only; they cannot grant API access.
- Persistent organization metadata, richer phase/feature fields, acceptance
  criteria, same-project dependencies and CRUD API operations with safe limits on
  deleting active work. Existing task requirements are immutable; priority is editable.
- Local AI planning with editable/validated JSON drafts and explicit human approval.
  Approval creates independent draft runs, preserving the execution review gates.
- Per-run operation locks, duplicate start/review rejection, configurable global,
  per-project and inference admission, dependency-aware dispatch/restart recovery,
  queued pause checks and active model cancellation.
- Revision IDs and SHA-256 workspace content digests attached to reviews. Stale
  versions and external changes are rejected. Legacy unhashed revisions require a
  new manual snapshot. Human edits create a new revision and invalidate the current
  check list. Prior revision evidence remains persistent.
- Independent worktree conflict warnings for overlapping changed paths, Git diffs
  for deleted files and hash-verified final approved patch export. No source merge.
- Fsync/atomic JSON replacement and in-memory rollback that preserves entity
  references held by concurrent operations. Historical v0.6 data remains readable.
- Loopback-only model endpoints, redirect rejection and best-effort prompt secret
  masking. Malformed model actions have bounded safe retries. Exhausted action
  loops fail instead of being presented as a successful execution.
- Additional file/delete/diff/test tools, configurable role path policies copied
  to runs, preserved test/check evidence per revision and lint/typecheck detection.
- Docker writable scratch tmpfs with read-only sanitized input, named-container
  cleanup after errors/timeouts and conservative resource/network restrictions.
  The legacy host CLI adapter is unavailable through secured execution routes.
- SSE reconnect refresh, live cancellation UI, task acceptance/dependency inputs,
  planning editor, conflict warnings, preserved portfolio and updated startup/docs.

## Validation results

| Check | Result |
|---|---|
| `npm test` | **22 passed, 0 failed, 0 skipped** |
| `npm run build` | **PASS**; Next.js 15.5.28 compilation, type validation, static pages and middleware |
| `npm run typecheck` | **PASS** (`tsc --noEmit`) |
| `npm run check:client` | **PASS**, 4 component directive checks |
| `node scripts/smoke-test.mjs` | **PASS**; 4 stages, correction, approval, 12 files, ZIP export |
| `node scripts/portfolio-smoke.mjs` | **PASS**; 4 simultaneous review lanes, seed idempotency, hierarchy and task creation |
| `node scripts/real-portfolio-http-smoke.mjs` | **PASS with MOCK model and REAL files**; imported Git, auto-start, tool edits, 4 approvals, original tree unchanged |
| `node scripts/realtime-smoke.mjs` | **4 passed**; authenticated SSE/reconnect and model stream parser checks |
| `node scripts/live-model-test.mjs` | **LIVE MODEL PASS**, installed `qwen2.5-coder:7b` |
| Ollama `/api/tags` | HTTP 200; required Qwen model installed |
| Docker daemon check | **UNAVAILABLE**; cannot connect to local Docker socket |

The actual Qwen live test performed `read_file`, `apply_patch`, `finish` against a
throwaway isolated Git worktree. It changed `backend/greeting.mjs` to return
`hello-teamforge`, verified a real diff and verified the original source remained
unchanged. This is a live backend coding smoke test, not evidence of the entire
five-project scenario running on the real model. Its fixture had no package scripts,
so automatic sandbox checks were correctly marked skipped.

The mandatory five-project integration scenario uses deterministic mock local
Ollama HTTP responses and real Git/filesystem operations. It creates five projects
with team members, a User Management phase, Authentication feature and four tasks;
observes QA/Frontend/Backend/Analysis awaiting review simultaneously; rejects
Password Reset with a file/line comment; verifies changed revision/content and
feedback-driven correction; approves Backend; verifies siblings stay in their
stages; completes the first task through QA; exports a real Git patch; recreates
the backend stores; verifies persisted history and an unchanged original source.

Additional tests cover hierarchy changes/dependencies, planning gate/double
approval, credentials/roles/project isolation, stale and duplicate reviews, manual
revision tracking, per-project queue admission, interrupted state recovery,
cancellation/abort, malformed actions, missing Ollama, file policy override,
symlinks/traversal/secrets and real authenticated HTTP/SSE/audit behavior.

Initial failures were investigated rather than hidden: sandbox loopback restrictions
were resolved by running local integration tests with the necessary permission;
a macOS `/var` versus `/private/var` assertion was canonicalized; transactional
rollback invalidating live entity references was repaired; asynchronous test cleanup
was made to wait for a stage's active execution to finish.

## Files changed / added

- `.env.example`, `package.json`, `package-lock.json`, `README.md`.
- Server: `server.mjs`; core `engine.mjs`, `store.mjs`, `portfolio.mjs`,
  `coding-agent.mjs`, `coding-files.mjs`, `sandbox.mjs`, `llm.mjs`.
- New core modules: `auth.mjs`, `durable.mjs`, `planning.mjs`, `redact.mjs`.
- Tests: new `enterprise.test.mjs`, `http.test.mjs`, `runtime-errors.test.mjs`;
  canonical-path assertion in `portfolio-real.test.mjs`.
- Web: `middleware.ts`, `next.config.mjs`, `components/Dashboard.tsx`,
  `components/PortfolioBoard.tsx`, new `app/team/page.tsx`.
- Scripts: `dev.mjs`, all four existing HTTP/realtime smoke entrypoints;
  new `live-model-test.mjs`, `http-test-auth.mjs`, `reset-password.mjs`.
- Documentation: `ARCHITECTURE.md`, `SECURITY.md`, this report; original README
  archived as `README-v0.6.md`.

## Remaining scope and security limits

This is a substantial local MVP improvement, **not completion of every enterprise
requirement in the supplied master prompt**. There is one organization, one local
API process, JSON rather than cross-file database transactions, Basic authentication
rather than enterprise SSO, and no complete credential revocation lifecycle or
multi-process lock. The host owner can alter audit/history data. Cleanup is manual.

The interface supports review/correction conversations, but not a separate general
agent Q&A chat. Some project metadata/CRUD and role policy operations remain API-only.
There is no arbitrary dependency graph editor, multi-language command catalog,
automatic merge, commit UI, CI infrastructure, full organization analytics page,
signed audit trail, at-rest encryption or automated workspace garbage collection.
Existing data migration is additive; there is no versioned database migration tool.

Container execution could not be validated because the Docker daemon was not
running. No container check is claimed to have passed. Dependencies are not installed
by the runtime. Full real-model multi-stage acceptance and visual browser QA were
not performed; the build, HTTP workflows, mocked acceptance and small real-model
coding test provide the reported evidence. See SECURITY.md for filesystem inventory,
redaction, persistence/crash and privilege boundaries before importing private code.

## Run

```sh
cd /Users/mohammadkoolivand/Downloads/teamforge-v0.6.0-real
npm run dev
```

Open http://127.0.0.1:3000/portfolio. Username defaults to `admin`; the first-start
password is printed by the API. If lost, stop the API, run
`npm run auth:reset -- admin`, save the newly printed password and restart.
Full installation, Ollama, sample-repository and test commands are in README.md.

## Follow-up: empty-repository import and agent creation loop

The GitHub source shown in the follow-up had no refs/commits. Import now reports
that explicitly, supports resolving a broken default HEAD to an existing main/master
branch, and offers an explicit UI checkbox authorizing an empty initial commit
only in the isolated clone. No changes are pushed to the source. Starting a real
run is hidden until import succeeds. Two dedicated Git regression tests pass.

The subsequent live screenshot exposed a create_file schema mismatch: the runtime
accepted the action name but passed it to apply_patch, requiring search/replace
rather than content. create_file now accepts its documented content field, validates
role/path/content, and refuses existing files. Empty repositories receive explicit
guidance; missing reads return exists:false with next-step instructions. Repeating
the same tool failure three times or six total tool failures stops execution with
a real failure. Each internal runtime run also has a ten-minute wall-clock bound.
An analysis with no artifact cannot appear as ready for review.

After these fixes, `npm test`: **26 passed, 0 failed, 0 skipped**. New deterministic
tests cover missing-file guidance, real creation from content, overwrite refusal,
and bounded repeated tool errors. The optional live test now supports `--empty`.

The follow-up `node --env-file=.env scripts/live-model-test.mjs --empty` was
attempted against the running installed Qwen service but ended in `TimeoutError`
before producing a file event. Therefore live empty-repository analysis is **not
verified** by this run; the passing earlier live backend smoke test must not be
used as evidence for this new scenario. No source repository was modified.

## Follow-up: safe corrections to existing analysis documents

The next screenshot showed that creation had succeeded, but the small model kept
guessing exact search strings while applying reviewer feedback to an existing
document. The analyst now receives a simpler read/write/finish tool contract.
`write_file` saves complete revised content only after this invocation has read the
existing file. The server compares that observed content again before writing;
blind writes, stale reads, deleted-after-read files, forbidden paths and roles are
rejected. Exact patching remains available for coding roles. Existing files are
never silently overwritten through create_file. Empty existing files can be edited
with an exact empty-content match. Successful writes explicitly tell the analyst
to finish once its deliverable and reviewer feedback are addressed.

Dashboard snapshot requests now ignore obsolete responses and periodically refresh
the selected run so a late SSE response cannot leave an old running status stuck.

Validation: **28 automated tests passed, 0 failed, 0 skipped**; TypeScript passed.
`node --env-file=.env scripts/live-model-test.mjs --correction` also **PASSED using
the actual installed qwen2.5-coder:7b**. The observed actions were read_file,
write_file, finish. It preserved the existing Requirements text, added Definitions
for the human review feedback, generated a real Git diff and verified that the
original source was unchanged. This is evidence for the real analysis-correction
flow; it does not change the earlier empty-repository live test timeout result.

## Follow-up: 130-second timeout on the user's Persian analysis correction

The persisted run showed failures at exactly 130 seconds (18:34:04.736 to
18:36:14.751 UTC), matching the old absolute timeout applied to every tool-action
response. The new `ollama-request.mjs` distinguishes model startup/queue wait,
stream inactivity, and an absolute response cap; request progress reports elapsed
time. Defaults are 180/90/600 seconds, configurable in `.env`; the stage deadline
is 900 seconds. NDJSON reading terminates immediately on a final done frame,
cancels the reader, and rejects token-limit truncation. A JSON action schema and
smaller analysis token budget replace unrestricted JSON generation.

An initial isolated replay with these transport changes still encountered a real
idle-stream timeout, so increasing limits alone was not reported as sufficient.
For an existing analysis correction (up to 8,000 characters), the runtime now
pre-reads the document into its observed-content guard and sends one narrowly
constrained write_file request for that exact path. Successful corrections are
returned for human review without another model inference to emit finish. Other
coding roles retain the multi-step tools. Read/version/path/role checks and human
approval gates are unchanged.

Validation after the focused correction change: **32 tests passed, 0 failed,
0 skipped**, including active slow streams, idle/start/total deadline distinctions,
reader completion without HTTP closure, token truncation, and a single-inference
analysis correction with preserved prior content.

The command `node --env-file=.env scripts/replay-analysis.mjs
70aebf79-321c-49ce-ac26-de0297480b36` then **PASSED with the actual installed Qwen**.
It read the actual failed project's existing Persian analysis and reviewer feedback
into a disposable Git fixture. Observed operations were read_file and write_file;
the saved document contained Definitions and produced a real diff. The original
user workspace remained unchanged. This is a live reproduction of that specific
correction, not a mocked result or an automatic approval of the user's execution.

## Follow-up: backend/frontend role confusion and zero-code reviews

Both coding roles were receiving an analysis-file create example from the common
tool prompt. The runtime now supplies role-specific writable examples, read-only
analysis context, allowed path guidance and strict command-key suggestions. The
file policy still prevents backend/frontend writes to analyst-owned documents.

Real Backend/Frontend finish requests are refused without a net non-document
implementation/configuration delta. One premature finish can be corrected by the
model; repeated empty completion fails instead of entering human review. Both the
Engine output boundary and review approval API enforce the artifact gate. Net
create/delete and edit/revert pairs cannot satisfy it. Demo workflow semantics
are retained and labeled demo.

Older empty awaiting reviews have an explicit correction/rerun button. Since the
next user screenshot showed an already approved empty backend and an empty
frontend review, an authorized reviewer can explicitly reopen that empty approved
stage. This preserves prior approvals/comments in history, appends reopening
records, leaves approved analysis intact, and invalidates dependent empty stage
reviews for re-execution. A later stage cannot be approved or resumed past an
empty prior coding approval. Reopening refuses active runs or later stages with
implementation changes, requiring broader dependency review instead of discarding
real work. The new endpoint uses the same project role and assigned-reviewer
checks as stage reviews and is recorded in the HTTP audit.

Validation: **38 tests passed, 0 failed, 0 skipped**; TypeScript passed. Targeted
reopen tests also pass after the resume guard: approved analysis remains approved,
prior review records are preserved, backend code is really written in a worktree,
and dependent empty frontend review returns to pending. Unauthorized reopening
is covered by the authenticated HTTP test.

A live isolated backend replay using the actual project analysis created
`backend/server.mjs`. It also attempted a command outside the allowlist, which was
correctly rejected. The replay then reached its 360-second overall test deadline
before complete agent finish, so a successful full live backend run is **not
claimed**. The generated fixture was removed; the user's workspace was unchanged.

After checking there were no active user executions and verifying process paths,
the local TeamForge dev launcher was gracefully restarted. API and web listeners
are ready on 8787 and 3000 with the new code. Accounts, projects and review history
were retained. The human still explicitly chooses to reopen the legacy empty
backend stage; no approval/reopen identity was impersonated by the agent.

## Reviewed Git publication

Added opt-in publication after final human QA approval, targeting develop in this installation. Private-index commit construction preserves the worktree and original source; persistent commit SHA supports retries without duplicate commits. HTTPS only, existing Git credentials, normal non-force push, hash and approved-path guards; manager/admin retry endpoint and dashboard status. Automatic publication does not run retroactively at startup. Temporary bare-remote tests exercise actual commits/pushes and rejection of concurrent remote history; no live GitHub write was used for verification.

Validation: 39/39 Node tests passed with loopback access, and TypeScript check passed. Publication integration test used a temporary local bare remote through a fixture-only HTTPS URL rewrite; no production GitHub push occurred during testing.

## Portfolio queue and recoverable deletion

Added sequential project queues, bulk task entry, lazy Git import at dispatch (HTTPS develop supported), queue guards against manual bypass, retry and publication blocking, delete/archive of active and draft tasks, project cascade archive, restore UI/API, and scoped demo cleanup. Existing parallel projects remain compatible. Seeded demo project and its four runs were archived in the user's installation; real execution history and published commits were retained. Full suite: 40 tests passed; subsequent HTTP authorization and queue tests passed after final changes. TypeScript validation passed. Queue tests use deterministic fixture agent output, not a live model claim.

Production Next.js build passed using isolated `.next-queue-check` output to preserve the running development server.

Single-task creation fix: missing/empty feature IDs now resolve to an existing feature or create default phase/feature structure after input validation, under the project creation lock shared with bulk entry. Invalid explicit feature IDs are rejected. Single-task submissions preserve priority, criteria, dependencies and queue flags. Added HTTP regression and real-mode fixture tests including concurrent first-task creation. Form now labels automatic structure selection, scrolls within the viewport, shows inline errors, and keeps per-project session drafts. Full suite: 41 tests passed; TypeScript check passed.

## Coding runtime progress recovery

The backend run d2fbefe0 timed out after alternating full-file writes with empty-search patches. Added per-action required fields and nonempty patch-search constraints to Ollama's JSON schema, compacted repeated source bodies in message history, increased context to 8192, and checkpointed net file deltas after each successful mutation. Repeated identical writes now receive a no-progress response and stop after two repetitions instead of exhausting the stage deadline. A resumed attempt validates checkpoint contents, retains original before/after evidence, and still requires finish, automatic checks, and human review. Stage timeout is localized and explicitly preserves progress. Added abort/resume, external-edit rejection and no-progress regression tests. Recovered the user's existing saved backend file into the interrupted task checkpoint and resumed backend without changing approved analysis or approving any output. Live completion is recorded separately from fixture tests.

## Focused UI and client performance improvements

Kept the existing workflow. Collapsed optional AI planning, acceptance criteria and long file conflict lists; added bulk task count and submission limit feedback, per-project session drafts for bulk input, keyboard Escape/autofocus/dialog semantics, visible keyboard focus and reduced-motion support. Board polling runs every five seconds with overlap prevention, retains unchanged snapshots, and pauses while hidden; model-health polling is every thirty seconds with overlap protection. Review dashboard coalesces SSE refresh bursts, uses a fifteen-second fallback instead of three seconds, and pauses fallback refresh/render updates while hidden. Recent logs render 100 entries initially with explicit load-more access to retained history. User action errors are no longer cleared by automatic refresh. TypeScript and client-directive checks passed. No model, queue, approval or publication behavior changed in this pass, and the active QA run was not restarted. These are implementation-level reductions; no end-to-end inference speedup was measured.
