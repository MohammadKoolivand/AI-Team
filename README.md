# TeamForge 0.7 — Local engineering MVP

TeamForge keeps the existing Next.js, React, TypeScript, Tailwind, Node API,
Ollama and Git-worktree architecture. Each work item has its **own** human-gated
Analysis → Backend → Frontend → QA pipeline. Multiple projects and task stages
coexist while the default inference limit remains one.

This release adds authenticated accounts/project roles, version-bound reviews,
planning drafts, task dependencies, cancellation, recovery scheduling, durable JSON
writes, conflict warnings and approved Git patch export. Existing `/portfolio` and
v0.6 project data are preserved. It is a local MVP, **not a banking production system**.

## Run on macOS

Requirements: Node.js 22+, npm and Git. Ollama is needed only for real execution;
Docker is needed for actual agent-triggered tests/builds. No paid/cloud API is used.

```sh
cd /Users/mohammadkoolivand/Downloads/teamforge-v0.6.0-real
npm install
cp .env.example .env
```

Edit `.env`: set `TEAMFORGE_IMPORT_ROOTS` to a trusted parent directory. Optionally
set a unique `TEAMFORGE_ADMIN_PASSWORD` of at least 12 characters **before first
startup**. Otherwise a random password is printed once by the API. Only its scrypt
hash is stored. Existing accounts are not reset by changing bootstrap variables.
If the initial password was lost, stop the API, run `npm run auth:reset -- admin`,
record the newly printed password, then restart the application. This owner-only
local command stores a new hash; no password is stored in plaintext.

```sh
npm run dev
```

Open [the portfolio](http://127.0.0.1:3000/portfolio). The browser requests a username
and password; the default bootstrap username is `admin`. The same login protects
the API. Keep loopback binding. `.env` is loaded by the combined startup script.

```sh
# Separate terminals, if preferred:
npm run dev:api
npm run dev:web

# Build and run the optimized app:
npm run build
npm start
```

The web proxy/middleware use API port 8787. Keep this default when using the
provided startup commands. Web UI is on 3000.

## Demo workflow

In `/portfolio`, choose **ساخت سناریوی تست خودکار**. The seeded project has four
independent tasks awaiting human review in Analysis, Backend, Frontend and QA.
Synthetic historical approvals and template-generated files are labeled demo.
Open any card to review its files, request corrections or approve its next stage.
Demo mode does not call Ollama or implement arbitrary custom requirements.

## Real repository workflow

1. Create a project in `/portfolio` using the administrator account.
2. Open `/team`, create human accounts and assign project roles. `manager` manages
   project structure/executions; `analysis`, `backend`, `frontend`, `qa` approve
   their corresponding stage; `viewer` reads. Assign a reviewer role separately
   when a manager should review. The system administrator can override locally.
3. Connect a local Git repository **before** creating tasks. The path must be inside
   `TEAMFORGE_IMPORT_ROOTS` and contain at least one commit. In the execution page, an empty repository can
   instead be imported by explicitly selecting **آماده‌سازی مخزن خالی در کپی ایزوله**;
   this creates an empty initial commit only in the private clone, without a push.
   Uncommitted source
   changes are not imported. Each task clones the committed repository into its
   own worktree; the original working tree remains unchanged.
4. Create phases/features and tasks with acceptance criteria, priority and optional
   dependencies. Real tasks start automatically when dependencies complete.
   Each stage stops for human review. Existing runs do not inherit later changes
   to reviewer assignments; assign team accounts before creating tasks.
5. Alternatively ask the AI Analyst for a plan. Edit its JSON draft, save it, then
   approve it. Approval creates draft work items. Start those tasks individually.
   A repository-backed project creates real runs; unconnected projects create
   clearly labeled demo runs. A plan never approves its own business requirements.
6. In task detail, inspect diffs/line numbers, test evidence and history. Comments
   can name a file and line. Corrections rerun that stage. Manual edits create a
   new revision. Approvals name that revision and verify the workspace hash. Real Backend/Frontend
   stages must contain a net implementation/configuration change; documentation-only
   or empty output cannot be approved. For an older empty review, choose
   **اجرای مجدد پیاده‌سازی** to rerun that stage while preserving approved analysis.
7. After final QA approval, download **دریافت Patch تأییدشده** for manual integration.
   There is no automatic merge or commit to your source branch.

A safe sample repository can be generated without overwriting existing files:

```sh
npm run sample:repo -- /private/tmp/teamforge-sample
```

Add `/private/tmp` to your configured import roots for that fixture, then connect
`/private/tmp/teamforge-sample` in the portfolio. To run this authored sample API
manually, outside the AI runtime:

```sh
node /private/tmp/teamforge-sample/backend/server.mjs
```

## Ollama and sandbox checks

Use the already-installed `qwen2.5-coder:7b`; no model is downloaded automatically.
Start Ollama if its service is not running:

```sh
ollama serve
ollama list
```

Default endpoint: `http://127.0.0.1:11434`. Only loopback endpoints are accepted;
redirects and URL credentials are rejected. Real-model failure never falls back
to demo output. The native internal runtime is the supported engine. Legacy Codex
CLI source remains for compatibility tests, but secured API execution is disabled.

Docker checks require a running daemon and a locally available image:

```sh
open -a Docker
# Optional administrator setup, if this image is not installed:
docker pull node:22-alpine
```

Agent checks have no network, host shell access, or dependency installation. Test
scripts must be available in `package.json`; dependencies must be pre-provisioned
in a trusted image. Supported keys: `node_test`, `node_check`, `npm_test`,
`npm_build`, `npm_lint`, `npm_typecheck`. Missing dependencies/runtime are reported
as skipped or failed, never passed. Docker is currently unavailable in the
validation environment; see the test report.

## Tests

```sh
npm test
npm run check:client
npm run typecheck
npm run build
npm run test:http
node scripts/smoke-test.mjs
node scripts/portfolio-smoke.mjs
node scripts/real-portfolio-http-smoke.mjs
node scripts/realtime-smoke.mjs

# Optional actual installed local model, temporary Git fixture, 180-second bound:
npm run test:live
# Live analysis of a completely empty temporary repository:
npm run test:live -- --empty
# Live review correction of an existing analysis document:
npm run test:live -- --correction
```

The default suite uses deterministic **mock** Ollama HTTP responses. It covers
real file changes and Git isolation, five projects/four simultaneous review
stages, corrections, patch export, persistent history, auth/RBAC, cross-project
isolation, stale/duplicate reviews, cancellation, malformed output and SSE
reconnect. Passing this suite does not establish model quality or container test
execution. The optional live test reports `LIVE_MODEL` separately.

## Configuration and API

| Variable | Default / purpose |
|---|---|
| `DATA_DIR` | `./data`; keep all JSON and workspace files together |
| `HOST`, `PORT` | `127.0.0.1`, `8787` |
| `OLLAMA_URL`, `OLLAMA_MODEL` | Loopback Ollama, `qwen2.5-coder:7b` |
| `TEAMFORGE_IMPORT_ROOTS` | Required trusted repository roots, `:` separated |
| `TEAMFORGE_ADMIN_USER/PASSWORD` | First-run bootstrap only |
| `TEAMFORGE_WEB_ORIGINS` | Allowed browser write origins; localhost:3000 defaults |
| `TEAMFORGE_MAX_GLOBAL_EXECUTIONS` | `1`; executing real stages |
| `TEAMFORGE_MAX_PROJECT_EXECUTIONS` | `1`; per-project execution admission |
| `TEAMFORGE_MAX_INFERENCE_REQUESTS` | `1`; shared local-model limit |
| `TEAMFORGE_MAX_REPAIR_ATTEMPTS` | `2`; bounded automatic test repair |
| `TEAMFORGE_OLLAMA_START_TIMEOUT_MS` | `180000`; wait for first response bytes / model loading |
| `TEAMFORGE_OLLAMA_IDLE_TIMEOUT_MS` | `90000`; no response bytes while streaming |
| `TEAMFORGE_OLLAMA_RESPONSE_TIMEOUT_MS` | `600000`; absolute maximum per model response |
| `TEAMFORGE_DOCKER_IMAGE` | `node:22-alpine`, must be locally available |

`TEAMFORGE_MAX_CONCURRENT_AGENTS` remains the legacy fallback for inference limits.
Model requests distinguish a slow active stream from no response. The internal runtime
also has a 15-minute stage deadline; incomplete or token-limited actions never execute.
After a successful analysis-document correction, the server presents the saved artifact
for human review without another inference just to generate a finish message.

A stage holds its inference admission during its tool/check loop, so increasing
other limits alone does not create simultaneous model calls.

All API calls except `/api/health` require HTTP Basic. Portfolio create/update
endpoints accept JSON. The current routes include:

- `GET /api/session`, `GET/POST /api/users`, `POST /api/users/:id/memberships`
- `GET /api/portfolio`, `POST /api/portfolio/projects`
- `PATCH/DELETE /api/portfolio/projects/:id`
- `POST /api/portfolio/projects/:id/{phases,features,tasks,members}`
- `PATCH/DELETE /api/portfolio/projects/:id/{phases,features,tasks}/:itemId`
- `POST /api/portfolio/projects/:id/plan` with `{content: plan}` or `{}` for AI
- `POST /api/portfolio/projects/:id/plan/approve` with `{planId}`
- `POST /api/projects/:runId/{start,resume,pause,cancel}`
- `POST /api/projects/:runId/tasks/:stage/review` with
  `{action,revisionId,comment?,filePath?,line?}`
- `GET /api/projects/:runId/{events,repo,repo/diff,repo/patch}`

Only empty structures/draft tasks can be deleted; execution records/workspaces are
retained. Task requirements/dependencies are immutable after creation; use review
feedback or create a replacement draft. Item updates support titles/descriptions
for phases/features and task priority. Some administration fields remain API-only.

For a nonstandard repository layout, PATCH a project's `filePolicy` before creating
runs, e.g. `{ "filePolicy": { "analyst":["docs/teamforge/"], "backend":["custom-api/"],
"frontend":["custom-ui/"], "qa":["tests/","docs/teamforge/"] } }`. An explicit policy
denies paths absent from the relevant role's list. Prefixes ending in `/` are
folders; other entries are exact files. The server still blocks secrets/traversal.

Read [architecture](docs/ARCHITECTURE.md), [security limits](docs/SECURITY.md), and
[implementation/test report](docs/IMPLEMENTATION_REPORT.md) before using private code.
The [original v0.6 README](docs/README-v0.6.md) is preserved as historical reference;
its unauthenticated/CLI instructions are superseded by this README.

### Commit and push after QA approval

Set `TEAMFORGE_AUTO_PUBLISH=1` and `TEAMFORGE_PUBLISH_BRANCH=develop` in `.env`, then restart the server. Every real Git execution publishes only after all four human approvals, including final QA. The current installation enables this as requested. Existing completed executions are not published on startup; use the dashboard Commit/Push retry button.

Publication creates a commit from the reviewed files using a private Git index and pushes its SHA to `refs/heads/develop`. It preserves the isolated worktree HEAD/index and the original source repository. Commit identity defaults to `TeamForge <workspace@teamforge.invalid>`; configure `TEAMFORGE_GIT_AUTHOR_NAME` and `TEAMFORGE_GIT_AUTHOR_EMAIL` for your identity. HTTPS authentication uses the server host's existing Git credential helper; passwords/tokens are not stored in the app. Local imports capture the source repository's HTTPS origin when imported. Older local imports without a captured origin must be reimported.

Push uses normal fast-forward rules: it never forces, merges, or overwrites concurrent commits. Authentication, branch protection, or divergent history can reject publication; the dashboard and event log retain the error and commit SHA for retry. Resolve divergence explicitly before retrying. Publication failure does not erase QA approval. Skipped checks remain skipped; human QA approval is still required. Changes after the approved snapshot or outside reviewed paths block publication.

For github.com publication, TeamForge uses an already authenticated GitHub CLI credential helper when `gh auth status` succeeds, otherwise the existing Git credential helpers. No credentials are copied into the app. A GitHub 403 still requires write access to the target repository in that login/token.

### Project queue and recoverable deletion

On `/portfolio`, create a project, connect an HTTPS repository on its existing `develop` branch (or an allowed local Git folder), then enter tasks in the bulk box: one task per line, optionally `Title | full description`. Up to 100 tasks per submission; repeat submissions to extend the queue. Phase/feature structure is created automatically when needed. New projects created through the board use a sequential queue. Each task takes a fresh isolated source snapshot only when its turn starts. Human approval is required at every stage. When auto-publication is enabled, the next task waits for the previous task to be pushed successfully. Failed tasks require an explicit retry; failed publication uses the review dashboard retry button. Legacy parallel projects retain their behavior.

Delete buttons archive projects/tasks and stop removed executions; no source files, remote branches, commits, or review history are removed. The Deleted/Restore panel restores items. Tasks with active dependents must have those dependents removed first. Deleted projects are excluded from dispatch and deleted runs from the execution list. Demo cleanup only archives explicitly marked demo projects and demo-mode runs.
