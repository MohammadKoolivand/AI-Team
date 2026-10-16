# TeamForge v0.5.0 — Open-source Codex CLI engine with human-gated AI team

A local **Next.js 15 + TypeScript + Tailwind** TeamForge prototype using the **Apache-2.0-licensed Codex CLI** as an optional coding runtime and **Ollama local models**, while preserving human approvals for every stage. This release builds on TeamForge v0.4.0. The Codex binary itself is **not vendored** in this ZIP; install it from the upstream project.

## What was added in v0.5.0

- **Pluggable coding runtime:** choose **Codex CLI OSS + Ollama** or TeamForge's older built-in Ollama tool loop at project creation. `demo` mode remains available.
- **Real CLI orchestration:** TeamForge starts `codex exec --oss --local-provider ollama --model ... --sandbox workspace-write --ignore-user-config --ephemeral --json -`, feeds a role-specific instruction on stdin, and streams **tool events, command activity and final messages** to the SSE live dashboard. It deliberately does **not** display private model reasoning.
- **Roles and approvals unchanged:** Analyst → human approval → Backend → human approval → Frontend → human approval → QA → human approval → completed. A reviewer's requested changes restart the **same** role with the comment in its prompt.
- **Git worktree from 0.4 retained:** imported Git source stays untouched; TeamForge maintains an isolated worktree.
- **Additional isolated staging:** for each Codex CLI stage, TeamForge copies **approved, nonhidden, safe text files** (no `.git`, `.env`, symlinks or secret-named files) into a temporary repo. The CLI runs in the temporary repo, not the source/worktree. After successful completion, TeamForge **checks all output paths and roles before copying edits** back into its worktree. Any unexpected path, symlink, hidden file, deletion or oversize output causes the stage to fail without accepting modifications from that attempt.
- **Automatic checks:** when possible, the existing Docker-based test/build harness runs between stage completion and human review. A genuine failed check prompts up to two Codex repair rounds. `SKIPPED` is **not** a pass.
- **Reviewable changes:** before/after diff, affected file list, stage attempts, reviewer notes, manual edits and final approval still live in the panel. Download ZIP for a Git repository now exports only permitted text source files, excluding `.git` and hidden files.

## Requirements

- macOS/Linux with **Node.js 22+**, npm, Git.
- Install dependencies for web once: `npm install` (npm registry or corporate npm mirror).
- Local model server **Ollama**. Tested protocol interface: Ollama OpenAI-compatible local endpoint (`http://127.0.0.1:11434/v1`).
- For Codex runtime only, install official open-source CLI: `npm install -g @openai/codex`. Its source is https://github.com/openai/codex (Apache-2.0).
- **Docker** with `node:22-alpine` image for isolated test/build. When absent, checks are reported `SKIPPED`.
- Select a locally installed model with strong tool-use and enough context. `gpt-oss:20b` is an option but large for small RAM configurations; adjust to your hardware. `qwen2.5-coder:7b` may struggle to follow multi-step tool instructions and is not guaranteed to work well with Codex.

## Setup (macOS)

```bash
# One-time global CLI installation
npm install -g @openai/codex
codex --version

# One-time model setup. This example is large; use a suitable smaller local model if needed.
ollama pull gpt-oss:20b
# ollama serve                 # only when Ollama is not already running

git --version
unzip teamforge-v0.5.0.zip
cd teamforge-v0.5.0
npm install

# Allow import of trusted local Git repos under this directory
export TEAMFORGE_IMPORT_ROOTS="$HOME/Projects"
export OLLAMA_URL="http://127.0.0.1:11434"
export TEAMFORGE_CODEX_MODEL="gpt-oss:20b"
# docker pull node:22-alpine
npm run dev
```

- Panel: **http://127.0.0.1:3000**
- API: **http://127.0.0.1:8787/api/health**
- Create project → mode **Ollama** → runtime **Codex CLI OSS + Ollama** → enter requirement → create → import **Git Workspace** before start → Start.
- Review Analyst output, approve; review Backend output, approve; then Frontend, QA. Use a review comment to send the *same stage* back for corrections.
- **Important:** the Codex CLI runtime requires an imported Git repo. If you want to generate a blank demo, select the older internal engine or demo mode.

### Testing

```bash
npm test
node scripts/smoke-test.mjs
node scripts/realtime-smoke.mjs
npm run build # requires Next.js / npm dependencies
```

The test suite covers the previous engine, strict stage ordering, review comments, snapshot sanitization, role violations, JSONL stream parsing and end-to-end workflow using a **fake Codex binary**. This proves the adapter protocol and workflow, **not live Codex model quality**.

### Coding engine configuration

```env
OLLAMA_URL=http://127.0.0.1:11434
TEAMFORGE_CODEX_MODEL=gpt-oss:20b
TEAMFORGE_IMPORT_ROOTS=/Users/you/Projects
# Optional absolute path to installed Codex binary:
# TEAMFORGE_CODEX_BIN=/opt/homebrew/bin/codex
```

Codex always uses `--oss --local-provider ollama`; the adapter refuses remote or HTTPS Ollama URLs. To reduce exposure to global Codex preferences, it uses `--ignore-user-config`, an ephemeral `CODEX_HOME` and a reduced process environment. The process is run with the CLI's **workspace-write sandbox**, not with `--yolo`.

## Security and honest limitations

**Development prototype ONLY, not approved for enterprise deployment or sensitive banking code.** This is the most important qualification: **running a CLI against a local model does NOT on its own guarantee organizational DLP**. Codex is a host executable; its subprocess security relies on upstream Codex CLI sandbox and the host OS. Its tool execution is not running inside TeamForge's Docker testing container. Additional network egress enforcement, per-user OS isolation/containers, independently verified DLP and an enterprise audit are required before corporate use.

- The temporary staged repo excludes hidden files and many sensitive-named paths but cannot detect secrets embedded in otherwise normal source files. Hard-coded credentials need independent scanning.
- Role scopes are enforced on **accepted edits**, but this is not a substitute for sandboxing every tool operation. Temporary files from rejected runs are removed afterward; run only with trusted local repositories.
- Only safe text files (max 1,700 and ~16 MB total) are staged. Binary/image assets, `.gitignore`, `node_modules`, ignored files and some large files are excluded, so this is not suitable for every repository without extending the exporter.
- File deletion and renaming across stages are not supported in this adapter; such outputs are rejected rather than silently applied.
- Build/test checks require Docker and appropriate dependencies/cache inside the test container. Missing dependencies can cause test failure; `SKIPPED` must not be misrepresented as success.
- **No authentication, RBAC, project isolation between users, private network gateway, persistent queues, tamper-proof audit or auto PR/merge**. API binds to localhost and must not be exposed publicly.
- Model-driven implementation quality depends on the Ollama model, its context length and hardware; no equivalence to Codex cloud capability is claimed.
- No live run with a real Codex executable/Ollama model or Next.js production build was possible in the packaging environment. These require validation on your Mac.

## Repo layout

```text
apps/server/core/codex-runner.mjs        NEW: Codex CLI OSS adapter + staged workspace policy
apps/server/core/codex-runner.test.mjs   NEW: subprocess, policy and 4-stage workflow tests
apps/server/core/engine.mjs             Choose runtime for an imported repository
apps/server/core/store.mjs              Persist per-project runtime choice
apps/server/server.mjs                  API integration and safe ZIP export
apps/web/components/Dashboard.tsx        Runtime picker and human-review pipeline
apps/web/components/RepositoryPanel.tsx Git repo and diff viewer from 0.4
```

**Upstream docs:**
- Open-source Codex CLI: https://github.com/openai/codex
- CLI exec flag reference: https://learn.chatgpt.com/docs/cli/reference
- Local Ollama integration: https://ollama.com/blog/codex

---

## نسخه آزمایشی 0.5.1 — سناریوی چهار نقش هم‌زمان (Portfolio Board)

این بسته شامل **سورس کامل v0.5 به‌اضافه یک برد پروژه، فاز، فیچر و تسک مستقل** است؛ دانلود مدل جدید لازم نیست.

### راه‌اندازی

```bash
npm install
npm run dev
```

- برد پروژه‌ها: **http://127.0.0.1:3000/portfolio**
- پنل کدنویسی، نمایش تغییرات و تأیید هر مرحله: **http://127.0.0.1:3000/**
- در برد، دکمه «ساخت سناریوی تست خودکار» را بزنید. با یک کلیک، داده نمونه ساخته می‌شود.
- داده‌ها در `data/portfolio.json` و `data/state.json` و خروجی فایل‌های تولیدشده در `data/workspaces` ذخیره می‌شوند. اجرای دوباره دکمه داده تکراری نمی‌سازد.

### پروژه نمونه

**سامانه مدیریت درخواست‌های کارکنان**

**تیم:** نازنین (تحلیلگر)، علی (بک‌اند)، سارا (فرانت)، پیمان (QA). اشخاص فرضی‌اند.

**فازها:**
- فاز ۱ — درخواست و گردش تأیید؛ فیچرهای «ثبت درخواست و پیگیری» و «مدیریت تأیید و قوانین»
- فاز ۲ — گزارش‌ها و مدیریت؛ فیچر «گزارش‌گیری مدیریتی»

**چهار اجرای کاملاً مستقل:**

| تسک | مرحله در انتظار بازبینی | وضعیت |
|---|---|---|
| ثبت و پیگیری درخواست | QA | منتظر تأیید پیمان |
| فرم ثبت درخواست جدید | Frontend | منتظر تأیید سارا |
| API تأیید یا رد درخواست | Backend | منتظر تأیید علی |
| تحلیل قوانین اولویت‌بندی | Analysis | منتظر تأیید نازنین |

هر تسک به یک اجرای مستقل موتور v0.5 پیوند داده شده است، نه یک ایجنت مشترک قفل‌کننده کل پروژه.
با کلیک روی «باز کردن»، برای همان تسک تاریخچه اجرا، فایل‌های خروجی، Diff، کامنت، درخواست اصلاح، و تأیید انسان نمایش داده می‌شود.

**هشدار مهم درباره تست:** برای رسیدن به این چهار مرحله، داده‌های آموزشی در حالت `demo` تولید شده‌اند و تأییدهای مرحله‌های قبلی **ساختگی** هستند (در لاگ‌ها با عبارت `DEMO SEED` مشخص شده‌اند). این خروجی اثبات پیاده‌سازی Featureهای تجاری واقعی نیست. Docker ممکن است SKIPPED باشد، و تست QA در صورت اجرا نشدن نباید verified تلقی شود. برای کدنویسی واقعی هر تسک، هنگام ایجاد تسک `Ollama + Codex CLI` را انتخاب کنید، مخزن Git آن را در صفحه مربوطه وارد کنید و مدل لوکال را آماده داشته باشید. مدل `qwen2.5-coder:7b` از قبل نصب‌شده قابل امتحان است ولی سازگاری ابزار و کیفیت مدل تضمین نشده‌اند.

**محدودیت‌های این نسخه:** نه احراز هویت و RBAC و تخصیص معتبر مدیر/بازبین دارد، نه صف پایدار بین چند سرور و ادغام Worktreeهای یک مخزن، نه مدیریت conflict بین تغییرات هم‌زمان در ریپازیتوری واحد. در سطح تسک‌ها اجرا مستقل است اما ادغام کد در سطح پروژه هنوز به موتور merge و تأیید جداگانه نیاز دارد. استفاده از API فقط روی localhost و مخازن آزمایشی غیرحساس توصیه می‌شود.

### اجرای تست‌ها

```bash
npm test
node scripts/portfolio-smoke.mjs
node scripts/smoke-test.mjs
node scripts/realtime-smoke.mjs
```

تست‌های اضافه‌شده تضمین می‌کنند چهار تسک در چهار مرحله مستقل ساخته شوند، کامنت یکی بازاجرای همان ایجنت را فعال کند، تسک دیگری بدون تغییر بماند، حالت در دیسک ذخیره شود، و از API بتوان فاز و فیچر و تسک جدید ساخت. **بیلد پنل Next.js و اجرای مدل واقعی Ollama در محیط بسته‌بندی انجام نشده است** و باید روی سیستم نصب‌شده بررسی شوند.


### Fix release: v0.5.1-demo-fixed

- Fixed Next.js compilation error in `apps/web/components/Dashboard.tsx`: `'use client'` now appears as the first statement, before imports.
- Added `npm run check:client` to catch misplaced client directives without needing npm dependencies.
- To update a local checkout, replace the affected file or apply the one-line fix; reinstalling dependencies is **not** required.
- On an existing dev server, Next.js should recompile after saving the change. If needed, stop it and rerun `npm run dev`.

---

## نسخه ۰.۶ — اتصال واقعی برد چندتسکی به Ollama و Git

در این نسخه برای هر **پروژه سازمانی** می‌توان یک مخزن Git محلی تعریف کرد و سپس برای هر **تسک واقعی** به صورت خودکار یک Git Worktree مستقل ساخت. تسک بعد از ثبت مدیر، بدون کلیک اضافه وارد موتور Ollama می‌شود و در هر مرحله برای تأیید یا اصلاح انسانی متوقف می‌شود. وضعیت همهٔ تسک‌ها از برد `/portfolio` قابل مشاهده است. مدل پیش‌فرض همچنان `qwen2.5-coder:7b` و موتور داخلی `builtin` است؛ دانلود مدل تازه لازم نیست.

### آزمایش امن روی مک (بدون تغییر در پروژه‌های واقعی)

1. از نسخهٔ قبلی خارج شو و Terminal را در پوشهٔ این نسخه باز کن.
2. مطمئن شو Ollama در حال اجراست و مدل وجود دارد: `ollama list`. اگر اجرا نیست `ollama serve` را در ترمینال جدا بزن.
3. یک نمونهٔ محلی بساز: `npm run sample:repo` (پوشهٔ `sample-repo` و اولین Git commit را می‌سازد).
4. در همان Terminal متغیرها را تنظیم کن:

```bash
export TEAMFORGE_IMPORT_ROOTS="$PWD"
export OLLAMA_MODEL="qwen2.5-coder:7b"
export TEAMFORGE_MAX_CONCURRENT_AGENTS=1
npm install
npm run dev
```

5. `http://127.0.0.1:3000/portfolio` را باز کن و پروژه **جدید** بساز؛ پروژهٔ دموی قدیمی را برای حالت واقعی استفاده نکن.
6. در بخش **Git پروژه ← اتصال**، مسیر مطلق `sample-repo` خروجی دستور مرحله ۳ را وارد کن.
7. یک فاز و فیچر بساز، سپس یک تسک با عنوان «افزودن ثبت درخواست» و شرح زیر ایجاد کن: «در پروژه فعلی، endpoint ثبت درخواست را با اعتبارسنجی عنوان در backend اضافه کن و رابط frontend را برای ثبت درخواست توسعه بده. تست‌های موردنیاز را اضافه کن و تغییرات را مطابق ساختار موجود انجام بده.»
8. **Ollama محلی / موتور داخلی TeamForge** را انتخاب کن. پس از ثبت، تحلیلگر به صورت خودکار اجرا می‌شود؛ روی کارت «باز کردن» بزن تا خروجی، Git Diff، لاگ، نظر بازبین، «تأیید» یا «درخواست اصلاح» را ببینی. پس از تأیید تحلیلگر، بک‌اند و بعد فرانت و QA اجرا می‌شوند.

### محدودیت‌های مهم

- برای آزمایش موتور واقعی با Qwen، خود مدل Ollama باید روی همان مک روشن باشد. آزمون یکپارچهٔ توسعه‌دهنده با **سرور پاسخ‌گوی شبیه‌سازی‌شده Ollama** انجام شده و کیفیت مدل واقعی هنوز روی مک کاربر تأیید نشده است.
- هر تسک Worktree مستقل از وضعیت commit مخزن اصلی در زمان ایجاد تسک می‌گیرد. **تغییرات تسک‌های مستقل هنوز خودکار merge نمی‌شوند.** ادغام با شاخهٔ مشترک / Pull Request نیازمند مرحلهٔ بعدی است.
- در این نسخه روی مک، پیش‌فرض حداکثر **یک استنتاج هم‌زمان** است تا مدل ۷ میلیارد پارامتری حافظه را اشغال نکند؛ سایر تسک‌ها در صف Agent منتظر می‌مانند ولی بازبینی انسانی مستقل است. روی سرور GPU می‌توان `TEAMFORGE_MAX_CONCURRENT_AGENTS` را افزایش داد، با توجه به ظرفیت واقعی سخت‌افزار.
- Docker برای اجرای تست جداگانه اختیاری است. **`SKIPPED` برابر `PASSED` نیست.** بعضی تست‌های پروژه به dependencies خارج از تصویر ایزوله نیاز دارند؛ این نسخه packages را در طول تست دانلود نمی‌کند.
- API تنها به `127.0.0.1` bind می‌شود و **احراز هویت، RBAC و مجوز تأیید بر اساس هویت واقعی افراد هنوز وجود ندارد**؛ روی LAN یا کد محرمانهٔ بانکی بدون بررسی امنیتی مستقر نکن.
- Codex CLI اختیاری است؛ Qwen 7B در حالت موتور داخلی `builtin` آزمایش ساختاری شده است. مدل بزرگ یا API پولی لازم نیست.
- این بسته شامل `node_modules` و مدل LLM نیست. برای پکیج‌های پنل Next.js از npm cache یا رجیستری داخلی استفاده کن.
- برای حفظ پروژه‌ها و تسک‌های قبلی می‌توان پوشهٔ `data/` را پس از تهیه بکاپ، از نسخهٔ قبلی به این نسخه کپی کرد؛ **هیچ داده‌ای به‌صورت خودکار مهاجرت یا حذف نمی‌شود.**
