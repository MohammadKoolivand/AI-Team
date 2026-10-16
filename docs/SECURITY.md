# Security boundaries and remaining limitations

Keep the server on 127.0.0.1. HTTP Basic is suitable here only with a trusted local
machine/browser. Remote hosting needs TLS, stronger sessions/SSO, CSRF review,
credential lifecycle/revocation controls and a security assessment. Passwords are
salted scrypt hashes. Initial credentials are randomly generated unless the owner
sets bootstrap environment variables. Authentication failures are rate limited.
Browser cross-site writes and unknown origins are rejected.

This release is **not approved for sensitive banking source code**.

- One local organization and one API process per data directory; no multi-tenant
  boundary, distributed scheduler, database transactions or data-directory lock.
- JSON documents are atomic independently. A crash during planning/import/account
  membership changes can leave draft runs, unreferenced workspaces or a mismatch
  between display-team entries and permissions. Authorization uses `users.json`,
  not display names. Back up all files together. Workspaces are retained for audit;
  automatic deletion/garbage collection is intentionally unavailable.
- The OS account can read/edit workspace and history files. Revision hashes detect
  content changes at approval/export but do not defeat a malicious host operator
  racing filesystem checks or rewriting JSON. Audit records are not signed or
  immutable; failed authentication and unauthenticated Origin rejection are not
  persisted in the HTTP write audit.
- Workspace revision coverage follows the existing safe text inventory: hidden,
  binary and restricted paths are excluded, depth is bounded and at most 2,000
  text paths are visible. It is not a complete filesystem attestation.
- Secret redaction is pattern based. Secrets embedded in unusual source formats
  can evade detection. Inspect repositories and policies before import. Local
  inference does not prove that a separately configured Ollama process has no
  telemetry or network access.
- Default role classification is heuristic. Use project `filePolicy` to explicitly
  allow repository-specific paths. Policies apply to new runs; recreating an old
  draft is needed to use a new policy. Read access covers safe project files,
  while role policies restrict writes/deletes. Shared `package.json` is allowed by
  default for backend/frontend and can be removed in an explicit project policy.
- The legacy host Codex adapter is retained as source/compatibility tests; the HTTP
  API rejects its creation and write operations. Use the native Ollama runtime.
- Docker is required for agent-triggered commands. No Docker means unverified
  checks. Docker Desktop's isolation and the administrator-selected image remain
  part of the trust boundary; images are not downloaded automatically.
- A running Docker command can complete after cancellation, but it only sees an
  isolated copied snapshot. Its output cannot advance a cancelled run. Model
  inference itself is abortable. Pausing is between stage executions.
- Test failures/skips remain reviewable evidence. A human may explicitly accept
  incomplete test coverage; the interface does not label skipped tests as passed.
- Plans use ordered dependency references and only reference earlier tasks. There
  is no arbitrary dependency graph editor, external issue tracker, automatic merge,
  encrypted-at-rest storage, durable SSE replay, or account/password lifecycle UI.
- Existing approval records without a workspace hash remain historical. Newly
  created revisions carry hashes. Existing data is not silently re-approved.

Implementation gates require a net non-document file delta for real Backend and
Frontend stages. A create/delete or edit/revert pair does not count. This is a
minimum artifact check, not semantic proof that all requirements were implemented.
Human review remains responsible for correctness and scope. No-op/not-applicable
coding stages do not silently advance; changing a pipeline for that case remains
an explicit product limitation. Older empty awaiting-review records are retained
for history, but cannot be approved; a correction request reruns the same stage.
