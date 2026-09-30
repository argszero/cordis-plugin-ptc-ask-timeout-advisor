# @argszero/cordis-plugin-ptc-ask-timeout-advisor

Tells a PTC program's next request what its own deadline hid: that the human
question it was waiting on was **aborted**, not answered.

A Cordis plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness),
addressing discussion
[#8368](https://github.com/deepseek-ai/deepseek-harness/discussions/8368).

---

## The gap

In PTC mode the model can only call `run_code`; a program that needs a human
decision asks through the generated SDK:

```ts
const answer = await tools.ask_user_question({
  questions: [{ id: 'go', question: 'Deploy to production now?' }],
})
```

That program runs under a wall-clock deadline — `dsh-ptc-runtime-node`'s
`timeoutMs`, **default 120 000 ms**, capped by `maxTimeoutMs` at **600 000** —
and the runtime documents the deadline as covering everything the program does:

> Default elapsed deadline, **including nested tool and approval waits**.

Waiting for a person therefore spends the program's budget. When the budget
expires while the question is still open, two things settle, in this order:

```
tool/ptc-dispatch-start  ask_user_question
tool/ptc-dispatch        ask_user_question   isError=true   error.code=ASK_ABORTED
tool/result  run_code    "Error: code run failed (timeout): execution deadline reached (120000ms)"
```

The model reads only the second. Its text says *a program failed*, which is
indistinguishable from a program that crashed, and says nothing about the
question — so the deadline reads as an outcome the model can proceed past. The
ask tool's own contract says the opposite in so many words — **"A timeout is
never approval"** — and the report measured the control that separates the two:
the same question asked as a *model-direct* tool call waited over four minutes
for a real answer.

## What it does

The plugin wraps the public `tools/execute` waterfall — the one seam that sees a
program's nested sub-dispatches, because they run through the same registry
pipeline as model-direct calls. It keeps a small ledger keyed by the call tree's
`rootCallId`:

* a settled dispatch of an **ask tool** (`askTools`, default
  `['ask_user_question']`) that failed with an **abort code** (`abortCodes`,
  default `['ASK_ABORTED']`) is recorded against its call tree, and
* a settled **program** (`tools`, default `['run_code']`) that failed with
  `codes` (default `['CODE_RUN_FAILED']`) **and** whose message matches
  `deadlinePatterns` (default `['execution deadline reached']`) takes that
  record and — when there is one — calls `exec.deferContext(…)` with one
  user-role advisory:

```
The program was ended by its own execution deadline, not by anything it ran, and
it was waiting on you at the time.

A question was asked from inside the program (`ask_user_question`) and the run's
wall-clock budget expired before it was answered. That question is now ABORTED,
not answered and not skipped — `ASK_ABORTED`: "ask_user_question was aborted
before the user answered". No answer exists.
A deadline is a limit on how long the program may run; it is never an approval,
and it is not a decision by anyone.
…
What to do:
  1. Do NOT carry out the action that question was gating, and do not treat this
     failure as consent for it.
  2. The question can still be answered: ask it again as a direct
     `ask_user_question` call, outside the program. A question asked that way is
     not on the program's clock and stays open until the user answers or cancels
     it.
  3. If the work cannot go on without the answer, stop and hand it to the user.
```

The advice rides the result the program already produced: `deferContext` appends
the message to the next request **after** the `tool/result`, so the model reads a
failure it understands *and* the fact that failure was hiding. Nothing else
changes — no request is re-sent, no sandbox is widened, no session event is
rewritten, and the transcript of the timed-out run stays exactly as the harness
recorded it.

## What it refuses

Every gate is a narrowing: this plugin would rather miss a case than misfire,
because a false alarm here tells a model to re-ask a question the user already
answered.

| Situation | Result |
|---|---|
| A program that failed with its own exception (`code run failed (exception): …`) | nothing — that failure is its own diagnosis |
| A `timeout` kind of the runtime's own, worded differently (e.g. `compute budget exhausted`) | nothing — only the run deadline is this plugin's business |
| A deadline with no aborted ask behind it | nothing |
| A question the user **answered** inside the budget | nothing |
| A question that ended `ASK_TIMED_OUT` (the timed mode's own deadline) | nothing — that is a different outcome, whose answer channel stays open |
| A non-program call that fails with the same code and wording (`bash`, a composite tool) | nothing — the program-name gate |
| A second program in a call tree that already spent its record | nothing — the record is **taken**, never read |

`mode` follows the family habit: `advisory` (default) injects, `warn` only logs,
`off` unregisters the listener entirely. Start with `warn` to measure how often
your traffic matches before letting it change what the model reads.

## Install

```sh
npm install @argszero/cordis-plugin-ptc-ask-timeout-advisor
```

Then mount it — the package ships a bundle patch, so adding it to a profile is
one row:

```yaml
- insert:
    - id: ptc-ask-timeout-advisor
      name: '@argszero/cordis-plugin-ptc-ask-timeout-advisor'
```

Or with configuration:

```yaml
- insert:
    - id: ptc-ask-timeout-advisor
      name: '@argszero/cordis-plugin-ptc-ask-timeout-advisor'
      config:
        mode: advisory
```

## Requirements

* `@deepseek-ai/dsh-llm` `>=0.1.7-alpha.1 <0.2.0 || >=0.2.0-rc.1 <0.3.0`
* `@deepseek-ai/dsh-tools` `>=0.1.7-alpha.1 <0.2.0 || >=0.2.0-rc.1 <0.3.0`

Both ranges are one `||` segment per prerelease **tuple**, which is not cosmetic:
a range only admits prereleases whose `major.minor.patch` tuple matches one of its
own comparators, so `<0.2.0` does *not* admit the `0.2.0-rc.*` builds and a
lower bound of `0.1.7-rc.2` would not admit `0.1.7-alpha.1`. The published set
this admits is asserted exactly (both directions) in `test/packaging.spec.mjs`,
and `scripts/probe-lines.mjs` installs one representative build per segment,
rebuilds and runs the whole suite there.

## Configuration

| Field | Default | Meaning |
|---|---|---|
| `mode` | `'advisory'` | `advisory` injects · `warn` logs only · `off` registers nothing |
| `tools` | `['run_code']` | The PTC transport tool names |
| `askTools` | `['ask_user_question']` | The human-question tool names |
| `codes` | `['CODE_RUN_FAILED']` | Failure codes on the program that may mean "the budget ended it" |
| `abortCodes` | `['ASK_ABORTED']` | Failure codes on a nested ask that mean "the waiting ended before an answer" |
| `deadlinePatterns` | `['execution deadline reached']` | Regular-expression sources the program's failure message must match |

Every field is validated fail-loud at mount time: an unknown `mode`, an empty
list, a non-string entry or an uncompilable regular expression throws rather than
silently disabling the advisor — a typo that turned this plugin off would look
exactly like the gap it exists to close.

## Evidence

Three suites, no mocks of the thing under test:

* **`test/seam.spec.mjs`** (17 arms) mounts the real `@deepseek-ai/dsh-tools`
  registry, the real `run_code` transport and the real `CodeRunFailedError`, and
  drives a program backend that calls the very bindings `ptc.ts` built — so the
  plugin observes genuine `scheduler.prepare` → `dispatch` → `finalize` traffic,
  including the inherited `rootCallId` and the program's opaque `parent` token.
  It proves the reported sequence end to end and pins every refusal above with an
  arm of its own.
* **`test/advice.spec.mjs`** (16 tests) covers the decisions without a registry,
  including the fail-loud config validation and the ledger's take-not-read
  semantics.
* **`test/packaging.spec.mjs`** computes the peer range's *admitted set* with
  `node-semver` and requires it to equal the versions this package was run
  against, asserts the README quotes the range verbatim, and reads the sentences
  this plugin keys on out of the **published** bundles — the deadline sentence
  and `kind: 'timeout'` from `dsh-ptc-runtime-node`, both budget defaults from its
  schema, and `ASK_ABORTED` with its sentence from `dsh-user-questions`.

`npm run test:inject` mutates the source, rebuilds, and requires each mutation to
be caught by a named arm — an arm that stays green proves nothing, and is
reported as `SILENT`. `npm run test:probe-lines` installs the
latest build of each peer-range segment into an OS temp directory, rebuilds and
runs the suite there, reading every resolved version back. Both segments were
probed on 2026-09-30 — `0.1.7-rc.2` and `0.2.0-rc.2`, with all six harness
packages read back at the probed line — and the suite passed on each, 43/43.

## Honest boundary

This is a **stopgap**, and it does not settle the design question the runtime's
own documentation carries as open — *"Execution is one-shot — no yield/wait
API"*. It does not stop the deadline, restore the program, or answer the
question; it removes the specific lie that "a program failed" is the whole story.
The preferred fix remains upstream, and there are two:

1. do not count a human wait against a program's execution budget, or
2. surface the pending state in the program's own result, so the model learns it
   from the transport rather than from a plugin.

The wording this plugin keys on is the harness's, and it is pinned against the
shipped bundles for exactly that reason: if upstream rewords one, this plugin
stops matching and goes **silent** — the safe direction — instead of adapting
silently to a failure that is no longer the one it was written for.

## License

MIT.
