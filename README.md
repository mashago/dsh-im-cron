# dsh-im-cron

**English** | [简体中文](README.zh-CN.md)

[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)

**A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) plugin that adds scheduled tasks to IM chats** — for [`@xmanrui/dsh-im`](https://www.npmjs.com/package/@xmanrui/dsh-im). Create a task in natural language, let it run on time, and the result lands back in **the same chat**.

> It is a companion plugin for dsh-im, not a standalone IM channel.

## Screenshots

| A scheduled `agent` task in QQ | `imcron_list` in the chat |
|---|---|
| <img src="https://raw.githubusercontent.com/mashago/dsh-im-cron/master/docs/screenshots/qq-scheduled-agent-task.jpg" width="340" alt="QQ chat: the user asks for a top snapshot in one minute; the bot confirms the schedule and later replies with the report"> | <img src="https://raw.githubusercontent.com/mashago/dsh-im-cron/master/docs/screenshots/qq-task-list.jpg" width="340" alt="QQ chat: the user asks to list scheduled tasks; the bot answers with a table of tasks grouped by notify / command / agent"> |

---

## ⚠️ Read this first: it depends on dsh-im

This plugin **does not connect to QQ, send messages, or manage sessions**. It only decides *when* to run, *what* to run, and *where the result goes*.

| Layer | Owned by |
|---|---|
| IM channel: QQ connection, session binding, proactive send, target management | **dsh-im** |
| Scheduling: schedule, execute, collect the result, keep the books | **this plugin** |

Delivery goes through the `dshIm` service exposed by dsh-im (`contractVersion: 1`). This plugin **does not import any dsh-im code**; it only calls `send` / `describeConversation` / `resolveTarget` per the service contract.

**Without dsh-im installed**: tasks can still be created, executed, and logged to `runs.jsonl`, but there is **no delivery channel** — the startup log shows `delivery=pending`, and every run records `deliver.status: skipped`.

```text
You (QQ): remind me to write the daily report every morning at 9
Bot: created imc-98c61823, next run 11-23 09:00

—— next day 09:00 ——
Bot: Daily report ✍️
```

---

## Why it exists

DSH's built-in `schedule_*` runs tasks inside a **session**; whether the answer is pushed back to the chat depends on the deployment switch `deliverModelAnswers` (off by default). So "send me a reminder at 9" is **silent by default** under native scheduling.

dsh-im solved "how to send a message to QQ" but has no timer. This plugin adds that layer, and splits three concerns apart:

| Concern | Owned by |
|---|---|
| **When it runs** | this plugin's scheduler (millisecond precision, see [Scheduling precision](#scheduling-precision)) |
| **Where it runs** | a dedicated task session (`agent` payload), not bound to the chat |
| **Who receives it** | dsh-im's `botId + targetId`, decoupled from the session → a user `/new` does not affect delivery |

---

## Three payloads

| Payload | What happens on the deadline | Model cost |
|---|---|---|
| `notify` | send a fixed piece of text | **0** |
| `command` | spawn a script, push stdout back | **0** |
| `agent` | run **one** agent turn in a dedicated task session, push the answer back | 1 turn |

`notify` / `command` never touch a model — there is no "let the model run arbitrary commands on the host" path.
`agent` uses a model for **execution** only; **delivery** is still model-free.

---

## Requirements

| Item | Required | Version |
|---|---|---|
| Node.js | ✅ | `>= 24.9.0` (same as DSH) |
| DeepSeek Harness | ✅ | `0.2.2-rc.x` |
| **[`@xmanrui/dsh-im`](https://www.npmjs.com/package/@xmanrui/dsh-im)** | **✅ required for delivery** | `5.10.0` (the `dshIm` contract was verified against this version) |
| Platform | — | macOS tested; Linux expected to work but untested; the Windows branch (`cmd.exe`) is statically checked only |

---

## Install

**① Install and configure dsh-im first** (QQ bot + a receive target), and confirm it can send and receive:

```bash
dsh plugin --profile web add @xmanrui/dsh-im
```

**② Then install this plugin**:

```bash
# from npm
dsh plugin --profile web add dsh-im-cron

# or point at a local directory / tarball
dsh plugin --profile web add /path/to/dsh-im-cron
```

Both must live in the **same DSH instance and the same profile** — this plugin finds dsh-im via `ctx.get('dshIm')`.

Confirm the rows were inserted into the profile:

```bash
dsh --profile web --dump-config | grep im-cron
```

The startup log should show:

```text
[im-cron] delivery=dshIm agent=on jobs=N stateDir=~/.dsh/im-cron
```

`delivery=pending` means dsh-im was not detected at startup (it is probed again on every use): `notify` / `command` still run, they just don't deliver.

> **Changes to the main plugin config (the `im-cron` row: `timezone`, `scriptDir`, `activeHours`, `jobs`, …) need a DSH restart**,
> because it is read at startup. The "agent task session" settings on the Plugins page are the exception:
> they take effect on the next agent run after saving.

---

## Quick start

Say this in the chat:

| You say | Payload created |
|---|---|
| "remind me about the meeting in 1 minute" | `notify` + `at` |
| "remind me to write the daily report every morning at 9" | `notify` + `cron` |
| "run stock-report.sh in 1 minute and tell me when it's done" | `command` + `at` |
| "run the closing script at 15:30 every day, no notification" | `command` + `cron` + `notify:never` |
| "summarize the financial news at 9 every day" | `agent` + `cron` |
| "check the processes every 2 minutes, stop after 3 runs" | `agent` + `every{minute,2}` + `maxRuns:3` |

Script payloads need the script placed in the [script directory](#script-payload) first.

---

## Tools

Nine tools, all registered on the global row `im-cron-tools` and visible to any agent.

| Tool | Purpose | Key arguments |
|---|---|---|
| `imcron_remind` | send a fixed text on schedule | `text`, `at`/`cron`/`every`, `timezone?`, `maxRuns?` |
| `imcron_run` | spawn a script on schedule | `script`, `timeoutSeconds?`, schedule, `notify?`, `maxRuns?` |
| `imcron_ask` | run one turn on schedule | `prompt`, schedule, `notify?` (`always`/`never`), `timeoutSeconds?`, `maxRuns?` |
| `imcron_list` | this chat's tasks, next run, last result | — |
| `imcron_update` | change schedule / text / `notify` / `maxRuns` | `id` + the fields above |
| `imcron_remove` | delete a task (**does not delete the delivery target**) | `id` |
| `imcron_pause` / `imcron_resume` | pause / resume | `id` |
| `imcron_trigger` | run once immediately, without changing the schedule or water mark | `id` |

Behavior notes:

- Creation tools return `{ id, nextRunAt, next3 }`; `next3` lets the user confirm "is it really this time" on the spot.
- `imcron_update` only changes schedule / text / `notify` / `maxRuns`; **payload type and target cannot be changed** — delete and recreate to switch.
- Changing the schedule **re-anchors** it; slots from the old schedule never fire.
- `imcron_list` **does not return `sessionId`** (useless for "which tasks do I have", and models read it out as noise). The task session id only appears in CLI `--verbose` and `runs.jsonl`.
- Target isolation: the model **cannot** name a bot or a chat; the target is looked up from the current session. Management tools cannot see tasks of another chat (someone else's id and "does not exist" return the same error).
- `imcron_list` distinguishes three states: **enabled** / **paused** / **finished**.

### Native `schedule_*` is disabled in IM sessions

Three layers; only the last one is mandatory:

| Layer | Mechanism |
|---|---|
| Prompt layer | system prompt section `tool:imcron` (**IM sessions only**, filtered by session id) |
| Visibility layer | `agent/created` → `tools.restrict({deny:['schedule_create','schedule_edit','schedule_list','schedule_view']})` |
| **Execution layer** | the `tools/execute` guard returns `isError` on a hit; the tool body never runs |

Reason: native scheduled answers are not pushed by default, and in practice the model reaches for them first.
**Web / desktop sessions are untouched**; `schedule_*` works there as usual.

---

## Time expressions

Three kinds, **mutually exclusive**; pick by semantics:

```jsonc
// one-shot
{ "at": "2026-11-21T09:00:00+08:00" }
{ "at": { "date": "2026-11-21", "time": "09:00", "timezone": "Asia/Shanghai" } }

// wall-clock rules (5 fields)
{ "cron": "0 9 * * 1-5", "timezone": "Asia/Shanghai" }   // weekdays at 9
{ "cron": "0 9,18 * * *" }                               // every day at 9 and 18
{ "cron": "0 9 1 * *" }                                  // the 1st of every month
{ "cron": "0 9 L * *" }                                  // the last day of every month

// intervals
{ "every": { "unit": "minute", "count": 90 } }                            // every 90 minutes
{ "every": { "unit": "hour", "count": 3 } }                               // every 3 hours from now
{ "every": { "unit": "day", "count": 15, "at": "06:00", "timezone": "Asia/Shanghai" } }
{ "every": { "unit": "week", "count": 2, "at": "10:00", "timezone": "Asia/Shanghai" } }
```

Which one:

| The user says | Use |
|---|---|
| a specific instant / a specific day | `at` |
| weekdays, several times a day, a day of the month, a month | **`cron`** (`every` cannot express these) |
| every N minutes / hours / days / weeks | `every` |

Rules:

- `cron` accepts exactly 5 fields; it rejects a seconds field, macros (`@daily`), and "value + step" (`0/15`); it supports `L` (last day of month).
- `cron` takes **local wall-clock time**; do not convert to UTC first.
- `*/15` means "the 1st, 16th and 31st of each month", **not** "every 15 days". Use `every{day,15}` for that.
- `every` with `minute` / `hour` is **instant-based**: anchored to the whole minute at creation, advanced arithmetically, so the interval is unchanged across DST.
- `every` with `day` / `week` follows the **local calendar**: wall-clock time is preserved across DST; a gap moves forward, an overlap takes the earlier instant.
- `at` must be strictly in the future; an instant that falls in a DST gap is rejected.

> **Anchor of the first run**
> `every{day|week, at}` starts from the **first future `at` instant** — a "every 15 days at 6am" task
> created in the afternoon first runs **tomorrow** at 06:00, not 15 days later. `minute` / `hour` count
> from the whole minute at creation. The `next3` returned at creation is there to check exactly this.

---

## Configuration

```yaml
- insert:
    - id: im-cron
      name: dsh-im-cron
      config:
        timezone: Asia/Shanghai
        scriptDir: ~/.dsh/im-cron/workspace
        activeHours: { start: '08:00', end: '22:00' }
        agent:
          enabled: true
          timeoutSeconds: 900
          permissionPreset: danger-full-access
        # operator-declared tasks (no model involved)
        jobs:
          - id: decl-close
            name: closing prices
            schedule: { cron: '30 15 * * 1-5', timezone: Asia/Shanghai }
            payload: { kind: command, script: stock-report.sh }
            deliver: always
            target: { botId: qq_xxxxxxxxxxxxxxxx, targetId: cron-0123456789ab }
```

| Key | Default | Description |
|---|---|---|
| `channel` | `dshIm` | channel id (only dsh-im today) |
| `requireChannel` | `true` | refuse to create tasks that need delivery when dsh-im is missing |
| `stateDir` | `$DSH_HOME/im-cron` | state directory |
| `scriptDir` | `<stateDir>/workspace` | script directory, see [Script payload](#script-payload). **The plugin does not create it** |
| `timezone` | host time zone | default zone for parsing / displaying schedules |
| `pollSeconds` | `30` | **fallback sweep** interval (not trigger precision, see [Scheduling precision](#scheduling-precision)) |
| `activeHours` | empty (all day) | execution window `{start, end, timezone?}` |
| `catchUp` | `none` | missed slots while down: `none` skip / `once` catch up once |
| `defaultTimeoutSeconds` | `600` | default script timeout |
| `endedRetentionHours` | `24` | how long a finished one-shot task is kept; `0` = never clean up |
| `maxNotifyChars` | `2000` | reminder text limit (checked at creation) |
| `maxJobs` / `maxJobsPerTarget` | `500` / `50` | task count caps |
| `allowChannels` | `['qq']` | channels allowed to create tasks |
| `allowGroup` | `false` | allow creating tasks in group chats (**script payloads are always disabled in groups**). The switch at the top of the plugin page toggles it live, no restart |
| `jobs` | `[]` | declarative tasks, upserted by id at startup (existing water marks are kept) |
| `agent.enabled` | `true` | only the `agent` payload is disabled when `sessionController` is missing |
| `agent.timeoutSeconds` | `900` | **soft deadline** of an agent turn |
| `agent.stuckGraceSeconds` | empty (soft × 2) | **hard deadline** of an agent turn |
| `agent.maxConcurrent` | `2` | cap on concurrently running agent turns |
| `agent.permissionPreset` | empty | permission preset for task sessions, see [Permission preset](#permission-preset) |
| `agent.taskSessionMaxAgeDays` | `30` | rotate a task session older than this |
| `agent.attachWorkspace` | `false` | whether task sessions join a workspace |
| `agent.echoToChat` | `false` | whether the digest is injected back into the chat session |

`activeHours` details:

- Slots outside the window are **skipped, never caught up** (a reminder past its window is stale information).
- `end` may be `24:00`; `start > end` means overnight (e.g. `22:00`–`06:00`).
- `start === end` means **all slots are off**.
- An invalid zone only warns and **does not restrict**; it never silently swallows every task.

---

## Script payload

`imcron_run` accepts **one existing executable file**, never a shell string.

```bash
mkdir -p ~/.dsh/im-cron/workspace
cat > ~/.dsh/im-cron/workspace/stock-report.sh <<'EOF'
#!/bin/sh
echo "report generated at $(date '+%F %T %Z')"
EOF
chmod +x ~/.dsh/im-cron/workspace/stock-report.sh
```

A script must satisfy three conditions:

1. it lives inside `scriptDir` (relative or absolute name; **it must still resolve inside after resolution**)
2. it is a regular file
3. it has the execute bit and a shebang on the first line

Rejected cases:

| Error code | Triggered when |
|---|---|
| `script-dir-missing` | `scriptDir` does not exist |
| `script-not-found` | the file does not exist |
| `script-outside-dir` | `realpath` resolution escapes the directory (including `../` and symlinks) |
| `script-not-executable` | no execute permission |
| `command-not-allowed-in-group` | creating a script task in a group chat |

Run conventions:

| Item | Value |
|---|---|
| cwd | `scriptDir` |
| Environment | `IMCRON_JOB`, `IMCRON_OCCURRENCE` |
| Timeout | the task's `timeoutSeconds`, else `defaultTimeoutSeconds` |
| Success | exit 0 |
| Delivered content | stdout; stderr when stdout is empty; on failure the exit code + the last 15 lines of stderr |

---

## Delivery policy

Three states:

| `deliver` | Success | Failure |
|---|---|---|
| `always` | send the result; when empty send `✅ <task> finished (no output)` | send `⚠️ <task> failed` + digest |
| `on-failure` | send nothing | same as above |
| `never` | send nothing | send nothing (only `runs.jsonl`) |

Defaults: `notify` → `always`, `command` → `on-failure`, `agent` → `always`.

**Error policy** (dsh-im has no `retryable`; the table below is the decision basis):

| Error code | Handling |
|---|---|
| `bot-not-connected`, `cancelled`, service not ready | keep `pending`, retry with backoff |
| `delivery-failed` / `send-result-unknown` | **do not retry** (a markdown chunk may have been sent with unknown result; resending duplicates the message); at most retry once as plain text |
| `unknown-bot` / `unknown-target` | mark the task `needs-rebind`, warn once |
| `invalid-target` / `bad-request` / `capability-unavailable`, etc. | record `failed`, no retry |

---

## Scheduling precision

Two levels:

| Mechanism | Role | Precision |
|---|---|---|
| **Deadline timer** | points at the nearest `nextDue` among runnable tasks and fires directly | milliseconds |
| **Fallback sweep** (`pollSeconds`) | catches up after laptop sleep, clock jumps, or a dead timer | ≤ `pollSeconds` |

**The timer is an optimization, the sweep is the guarantee** — a failed timer only degrades to polling, it never loses a task.
Waits longer than 6 hours are recomputed in slices (`setTimeout` overflow protection), which also handles DST.

Measured deviation: **9–38 ms** across the same batch of tasks (mostly around 10 ms).

---

## The `agent` payload

- One task, one **dedicated task session**: the first run calls `sessionController.create({cwd, agentPreset})` (then `selectModel` when a model route is configured); later runs reuse it via `resolveAgent`. Its cwd defaults to the plugin state directory (`$DSH_HOME/im-cron`); set `cwd` on the agent-session row to run somewhere else.
- The session is **not bound to a chat** → the channel never mirrors it → the answer appears **once**, when the plugin sends it. No double push.
- Turn ownership follows the message id of our `followup`: `turn/start` carries only `{turn}`, a `user/message` matching our id claims it, and `turn/end` for that turn closes it.
- **Two-stage timeout**: the soft deadline only logs and keeps waiting; only when the hard deadline passes does it `cancel({kind:'user'})` and record `failed/stuck`. A turn that finishes between the two still delivers its real answer.
- Concurrency: `agent.maxConcurrent`; waiting longer than `2 × pollSeconds` records `skipped: busy`; if the previous run of the same task is still going, it records `skipped: running`.
- Self-healing: `session/not-found` → recreate; `turn/end` with `blocked` (session archived) → drop the session, recreate next run.
- The session title is `⏰ <task name>` so it is findable in the sidebar (a title the user set by hand is never overwritten).

### Permission preset

`agent.permissionPreset` applies to **task sessions only** (it writes that session's own log); it does not affect chat or Web sessions.

| Value | sandbox | approval | Consequence |
|---|---|---|---|
| empty | deployment default (`workspace-write` + `ask`) | | calls that need approval **hang until the timeout** (see [Known limitations](#known-limitations)) |
| `workspace-write` | writable inside the workspace | `ask` | same as above |
| `danger-full-access` | fully open | `never` | no sandbox, no approval; setuid programs such as `ps` / `top` can run |

Equivalent manual config:

```yaml
- id: im-cron-agent
  name: dsh-im-cron/agent-settings
  config:
    cwd: ~/.dsh/im-cron
    provider: deepseek-account
    model: deepseek-flash
    reasoningEffort: low
    permissionPreset: danger-full-access
```

You can also change it from **Web → Plugins → dsh-im-cron** with the **配置任务会话** button in the page head (or inside the
`agent 任务会话` row). **It takes effect on the next agent run after saving** (the fields are Loader-volatile, and
`agent-turn.js` re-reads them on every run; a change rebuilds that task's session). The same dialog has the group-chat switch; it is saved by the same **Save** button.
Notify / script payloads are unaffected by these settings.

---

## Execution cap

`maxRuns` (1–10000) can be set at creation: after N runs the task is marked finished automatically.

- **Only scheduled runs count**: a manual `imcron_trigger` does not consume the budget
- An interrupted run (process restart) **does** count
- `imcron_update` resets the counter to 0 when it changes `maxRuns`
- `imcron_list` shows progress: `ran 2/3`

---

## CLI

```bash
node cli.js doctor                       # state dir, task counts, script dir, last run
node cli.js list [--verbose]             # tasks, next run, last result (--verbose adds sessionId)
node cli.js run <id> [--config cfg.json]  # run once now (the CLI has no channel, so delivery is skipped)
node cli.js log [--job <id>] [-n 50]     # tail of runs.jsonl
```

Common flag `--state-dir DIR` (default `$DSH_HOME/im-cron`).

---

## State and files

```
$DSH_HOME/im-cron/
  state.json              { version: 1, jobs: [...] }
  state.json.bak          copy from before the previous write
  runs.jsonl              run records, one per line
  workspace/              script directory (default; created by hand)
```

- Writes are `tmp → fsync → rename`.
- A corrupt `state.json` is copied to `state.json.corrupt-<timestamp>` and the plugin **starts empty**; DSH is unaffected.
- `runs.jsonl` fields: `at`, `jobId`, `mode`, `occurrence`, `trigger`, `durationMs`, `result{kind,exit?,reason?}`, `deliver{status,attempts?,error?}`, `sessionId?`, `turn?`, `textTail?`.

### Idempotency

For any `(jobId, occurrence)`, **the on-disk state allows exactly one execution to start**:

1. before running, the claim (`lastFiredFor` + `endedAt` + `inflight`) is fsynced to `state.json`
2. if the claim cannot be persisted, **this round does not run** (skip rather than risk a duplicate)
3. if the process dies mid-run, startup finds the leftover `inflight`, records `result.kind=interrupted`, clears it, and **does not replay** (at-most-once)

---

## Source layout

```
index.js              plugin wiring: probe dshIm / sessionController → scheduler + guards + declared jobs
config.js             zod validation + defaults
tools.js              the 9 imcron_* tools (global row im-cron-tools)
agent-settings.js     Loader row im-cron-agent (Web form)
client.js             Plugins-page form
diag.js               on-demand diagnostic log

core/schedule.js      at / cron / every parsing, nextDue, DST wall-clock engine
core/scheduler.js     deadline timer + fallback sweep, atomic claim, crash recovery, activeHours, maxRuns
core/job.js           payload dispatch → delivery states → runs bookkeeping
core/agent-turn.js    task sessions, turn ownership, two-stage timeout, answer extraction
core/scripts.js       script path resolution and directory escape checks
core/exec.js          process spawn, process tree, output tail
core/store.js         atomic state.json writes, runs.jsonl, corruption isolation

channel/dsh-im.js    send / resolveTarget / describeTarget / describeConversation(+Sync)
cli.js               doctor / list / run / log
examples/            example configs and demo scripts
```

`channel/dsh-im.js` is the **only** file that talks to dsh-im: switching channels means replacing it,
and everything under `core/` is channel-agnostic.

---

## Contract with dsh-im

This plugin depends only on the **service methods** dsh-im exposes; it does not import its code and does not read its state files:

| Method | Purpose |
|---|---|
| `send(botId, targetId, text, { format })` | proactive send: no session, no turn, no model |
| `describeConversation(sessionId)` | session → `{channel, botId, chatType, chatId, senderId}` (locating the target when creating a task) |
| `describeConversationSync(sessionId)` | same as above as an in-memory fast path; used by the routing guard and the prompt scope |
| `listTargets(botId)` | reuse saved delivery targets |
| `createTarget(botId, {targetId, name, kind, route})` | create a target for the first time (exactly these 4 keys) |

At startup it checks `contractVersion >= 1`; if any method is missing, only delivery is disabled — the plugin still loads.

**When upgrading dsh-im, check two things first**: whether `contractVersion` changed, and whether the `send` argument shape changed.
The adapter is concentrated in `channel/dsh-im.js` — switching channels or following contract changes means editing only that file.

> You can also hand-write two rows in the profile instead of installing the bundle; see `examples/config.yml`.

## Security model

| Surface | Control |
|---|---|
| What can run (scripts) | only an **existing executable inside `scriptDir`**; no shell strings; disabled entirely in group chats |
| What can run (agent) | whatever the task session's preset tool set allows; user chat sessions are untouched; an unanswered approval hangs until the timeout (see known limitations) |
| Who can receive | the target is looked up from the current session only; **the model cannot name a bot / chat** |
| How much can be sent | `maxJobs`, `maxJobsPerTarget`, `maxNotifyChars`, checked at creation |
| How much can run | `agent.maxConcurrent`, one run per task at a time; `cron` / `every` granularity is 1 minute (`at` can be per-second) |
| Audit | every run and delivery is written to `runs.jsonl` (no credentials) |

---

## Troubleshooting

| Symptom | Look at first | Fix |
|---|---|---|
| did not run on time | `下次` (next) in `cli.js list`, task count in `cli.js doctor` | confirm DSH is running and the task is `启用` (enabled). Precision comes from the timer; `pollSeconds` is only a fallback |
| ran but nothing arrived | `deliver.status` / `error` in `runs.jsonl` | `bot-not-connected` etc. → reconnect; `unknown-target` → the task becomes `needs-rebind` |
| the model says "can't create a task" | whether the chat is on QQ, `allowGroup`, `allowChannels` | the tools only work in IM sessions; Web sessions are told to go to QQ |
| the model never calls `imcron_*` | does the preset hide the tools | check the profile / preset tool set |
| an agent task is always skipped | `result.reason` | `running` = the previous run has not finished; `busy` = over `maxConcurrent` |
| an agent task reports `stuck` | `approval/asked` in the task session log | most likely it is sitting on `ask` with nobody answering; configure `danger-full-access` |
| `result.kind=interrupted` appears | the previous run's `inflight` for that task | the process died mid-run; that slot is **not replayed**. A one-shot task is already marked finished — **recreate** it if needed |
| `ps` / `top` reports `Operation not permitted` | the task session's `sandbox/mode` | `workspace-write` cannot exec setuid programs; use `pgrep` / `lsof`, or configure `danger-full-access` |
| cannot create a script task | the `scriptDir` line in `cli.js doctor` | the directory is missing, the script is not inside it, or it lacks `chmod +x` |

### Diagnostic log

Off by default. Set the environment variable **before starting DSH** when debugging scheduling:

```bash
IMCRON_DIAG=1 dsh web
IMCRON_DIAG=1 IMCRON_DIAG_FILE=/tmp/imcron-trace.log dsh web   # change the output location
```

JSON Lines, each line `<ISO time> [<module instance id>] <event> {<JSON>}`.
**Two different instance ids in the same process** mean the plugin module was loaded twice — the classic cause of "config not taking effect".
Under `npm test` it never writes.

---

## Known limitations

- **`ps` / `top` / `sudo` never work under `workspace-write`.** They are setuid binaries and the
  Seatbelt sandbox refuses to exec setuid programs, reporting `Operation not permitted`.
  No approval can fix this — only `danger-full-access` (no sandbox at all), or use `pgrep` / `lsof` / `vm_stat` / `iostat`.
- **An approval can stall an unattended turn.** When the task session sits on `ask` and a Web GUI is online
  (it registers an `approval/request` answerer), the request queues in the task session's UI for a human and
  nobody answers, so it waits until the soft deadline. Only when there is **no answerer at all** does it fail
  closed instantly. For unattended setups use `danger-full-access` (`approval: never`).
- Proactive messages in group chats may be throttled by the platform; failures are recorded as `delivery-failed` and not resent (they may already have been delivered).
- Group chats **do not support script payloads**.
- The CLI has no delivery channel, so `cli.js run` always records `deliver=skipped`.
- Task sessions appear in the Web sidebar under **Ungrouped** (title `⏰ <task name>`).
- The reminder text limit is checked **at creation**; script / model output is unbounded and chunked by dsh-im at 4500 characters.
- An agent turn for the same task is **single-flight**: when the previous run has not finished, this one records `skipped: running`, so "every minute" really means "at most once per minute".
- With several instances sharing one `stateDir`, idempotency only holds within a single process (startup `recoverInterrupted` takes over leftover claims).
- Only the dsh-im channel is implemented; another channel needs a new `channel/*.js` (see the source layout for the interface).
- The Windows branch (`cmd.exe`) is statically checked only.

---

## Development

```bash
npm install
npm test          # node --test, 172 cases
```

Coverage: time expressions and DST, the scheduler's atomic claim / crash recovery / `maxRuns` / `activeHours`,
the three payloads and delivery states, turn ownership and timeouts, script path validation, tool arguments and copy.

---

## License

[MIT](LICENSE)