/**
 * Fixtures and mounting for this plugin's suites.
 *
 * The fixtures reproduce, step for step, the sequence the reported session log
 * records for the gap this plugin closes (discussion #8368):
 *
 * ```
 * tool/ptc-dispatch-start  ask_user_question
 * tool/ptc-dispatch        ask_user_question  isError=true  error.code=ASK_ABORTED
 * tool/result  run_code    "Error: code run failed (timeout): execution deadline reached (120000ms)"
 * ```
 *
 * Four fidelity decisions are deliberate, and they are what make these suites
 * evidence rather than illustration:
 *
 * 1. **`run_code` is the real one.** The registry is mounted with
 *    `@deepseek-ai/dsh-tools`, the program transport comes from its own PTC
 *    layer, and the failure the model sees is produced by
 *    `CodeRunFailedError` — the shipped class. Nothing here re-implements the
 *    program wrapper.
 * 2. **The program is executed the way the runtime executes it.** A minimal
 *    `PtcRuntime` receives the bindings `ptc.ts` handed it and calls
 *    `tools.ask_user_question(…)`, which is exactly what the generated SDK does
 *    (`ptc.ts` builds `functions` from the visible schemas and lets the program
 *    call them by name). The plugin therefore observes real
 *    `scheduler.prepare` → `dispatch` → `finalize` traffic, including the
 *    inherited `rootCallId` and the program's opaque `parent` token.
 * 3. **The program never awaits the question.** A real deadline kills a program
 *    *while* it is awaiting — the continuation never runs. Modelling that is why
 *    the fixtures fire the binding and leave it pending; whether the run then
 *    ends in a timeout, in the program's own exception, or successfully is
 *    decided by what the fake runtime returns, not by what the program does
 *    next.
 * 4. **The deadline is reported the way the shipped runtime reports it.**
 *    `kind: 'timeout'` with the sentence
 *    `execution deadline reached (120000ms)` is `ptc-runtime-node`'s literal
 *    output; a real 120-second wall clock would prove nothing extra, and
 *    `packaging.spec.mjs` pins those literals against the published bundles so
 *    the fixture cannot drift from the artifact in silence.
 */

import { Context } from '@deepseek-ai/cordis'
import { HarnessError, ToolCallId } from '@deepseek-ai/dsh-llm'
import { PtcRuntime } from '@deepseek-ai/dsh-ptc-runtime'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { TOOL_RUNTIME_SCHEDULER, defineContentToolFixture } from '@deepseek-ai/dsh-tools'

import * as plugin from '../lib/index.js'

/** The ask tool the harness ships. */
export const ASK_TOOL = 'ask_user_question'

/** The program transport the harness ships. */
export const PROGRAM_TOOL = 'run_code'

/** The message `abortedQuestion()` writes (`dsh-user-questions`). */
export const ASK_ABORT_MESSAGE = 'ask_user_question was aborted before the user answered'

/** The program failure a deadline produces, as the shipped runtime reports it. */
export const DEADLINE_MESSAGE = 'code run failed (timeout): execution deadline reached (120000ms)'

/** The runtime's own deadline sentence, before `ptc.ts` wraps it. */
export const DEADLINE_TEXT = 'execution deadline reached (120000ms)'

/** The same code, but the program's own exception rather than the budget. */
export const PROGRAM_ERROR_MESSAGE = 'code run failed (exception): Cannot read properties of undefined'

/**
 * A `timeout` kind whose message is *not* the deadline sentence — the near miss
 * that proves the wording gate is load-bearing. A runtime is free to end a
 * program for a timeout of its own (a busy-loop budget, a subprocess cap).
 */
export const FOREIGN_TIMEOUT_MESSAGE = 'code run failed (timeout): compute budget exhausted (300ms busy)'

/** How a fake ask settles. */
export const ASK_BEHAVIOURS = Object.freeze(['aborted', 'answered', 'cancelled', 'timed-out'])

/** How a fake program settles. */
export const PROGRAM_BEHAVIOURS = Object.freeze([
  'deadline',
  'foreign-timeout',
  'exception',
  'no-ask',
  'answered-then-deadline',
  'fire-and-succeed',
])

/** The abort codes of the neighbour outcomes — near misses, never this case. */
const NEIGHBOUR_CODES = Object.freeze({ cancelled: 'ASK_CANCELLED', 'timed-out': 'ASK_TIMED_OUT' })

/** One settlement, resolvable from outside the fixture. */
function deferred() {
  let settle
  const promise = new Promise((resolve) => { settle = resolve })
  return { promise, settle }
}

/**
 * The fake ask tool.
 *
 * A cooperative ask settles when the signal it was handed aborts — the shape
 * `dsh-user-questions` has (`ask()` throws `abortedQuestion()` once
 * `request.signal` aborts, and `tool-ask-user` passes `exec.signal` straight
 * through) — and the signal it is handed is the *run's*, because `ptc.ts` sets
 * `signal: runController.signal` on every sub-dispatch. That is the mechanism
 * by which a human wait is spent out of the program's budget.
 * @param behaviour - which settlement this ask produces.
 * @param started - resolved the moment the body is entered.
 * @returns the fixture.
 */
function askTool(behaviour, started) {
  return defineContentToolFixture({
    name: ASK_TOOL,
    description: 'asks the user and waits for an answer',
    parameters: {},
    execute(_args, exec) {
      started.settle()
      if (behaviour === 'answered') {
        return Promise.resolve([{ type: 'text', text: 'the user chose the first option' }])
      }
      const code = NEIGHBOUR_CODES[behaviour] ?? 'ASK_ABORTED'
      const message = behaviour === 'aborted' ? ASK_ABORT_MESSAGE : `ask_user_question ended as ${code}`
      const failure = new HarnessError(message, code)
      if (exec.signal.aborted) return Promise.reject(failure)
      return new Promise((_resolve, reject) => {
        exec.signal.addEventListener('abort', () => { reject(failure) }, { once: true })
      })
    },
  })
}

/**
 * Ask, then have the run end while the question is still open.
 *
 * A module-level function rather than a private method on the backend: the
 * registry hands out a *view* of a mounted service, so `this` inside a method is
 * the view, and a view fails V8's brand check for `#private` members. (Measured:
 * one `#` in that class turns every arm into
 * `Receiver must be an instance of class FakeProgramBackend`.)
 * @param ask - the ask binding `ptc.ts` built.
 * @param started - resolved when the ask body was entered.
 * @param error - the failure the run reports.
 * @returns the run result.
 */
async function cutOff(ask, started, error) {
  void ask({}).catch(() => undefined)
  await started.promise
  return { logs: [], error }
}

/**
 * The program backend.
 *
 * `ptc.ts` hands every runtime the binding namespace it built, and the runtime
 * decides what calling those bindings means. This one calls them — which is all
 * a program is — and reports an outcome with the shipped failure vocabulary.
 * `timeout` mirrors the shipped runtime's own budget so the schema `ptc.ts`
 * projects from a mounted runtime is the production one.
 */
class FakeProgramBackend extends PtcRuntime {
  language = 'typescript'
  isolation = 'in-process-fixture'

  get timeout() {
    return { defaultMs: 120_000, maxMs: 600_000 }
  }

  constructor(ctx, config) {
    super(ctx)
    this.behaviour = config.behaviour
    this.started = config.started
  }

  resolve(request) {
    return { ...request, cwd: request.cwd ?? process.cwd(), timeoutMs: request.timeoutMs ?? 120_000 }
  }

  async run(spec) {
    const ask = spec.bindings[0].functions[ASK_TOOL]
    switch (this.behaviour) {
      case 'no-ask':
        return { logs: [], error: { kind: 'timeout', message: DEADLINE_TEXT } }
      case 'foreign-timeout':
        return { logs: [], error: { kind: 'timeout', message: 'compute budget exhausted (300ms busy)' } }
      case 'exception':
        return await cutOff(ask, this.started, { kind: 'exception', message: 'Cannot read properties of undefined' })
      case 'answered-then-deadline':
        // The user answered inside the budget; the program still ran out of it.
        await ask({})
        return { logs: [], error: { kind: 'timeout', message: DEADLINE_TEXT } }
      case 'fire-and-succeed':
        // The program asked and then finished: the question is still open when
        // the run ends, and the run succeeds anyway.
        void ask({}).catch(() => undefined)
        await this.started.promise
        return { logs: [] }
      default:
        return await cutOff(ask, this.started, { kind: 'timeout', message: DEADLINE_TEXT })
    }
  }
}

/**
 * A composite tool that fails with the very code and wording the deadline uses
 * — the near miss proving the program-name gate is load-bearing.
 * @param ctx - the context.
 * @param started - resolved when the ask body was entered.
 * @returns the fixture.
 */
function decoyTool(ctx, started) {
  return defineContentToolFixture({
    name: 'bash',
    description: 'runs a command',
    parameters: {},
    async execute(_args, exec) {
      // A composite tool dispatches through the scheduler, as `ptc.ts` does for
      // the calls a program makes: ordered pre-execute, then the waterfall.
      const scheduler = ctx.tools[TOOL_RUNTIME_SCHEDULER]
      const run = new AbortController()
      const input = {
        callId: ToolCallId(`${String(exec.callId)}:ptc:1`),
        rootCallId: exec.rootCallId,
        name: ASK_TOOL,
        parent: exec.token,
        arguments: {},
        signal: run.signal,
      }
      const prepared = await scheduler.prepare(input)
      const nested = prepared.kind === 'dispatch'
        ? scheduler.dispatch(prepared.exec) // eslint-disable-line no-await-in-loop
        : Promise.resolve(prepared)
      await started.promise
      run.abort('execution deadline reached')
      await nested
      throw new HarnessError(DEADLINE_MESSAGE, 'CODE_RUN_FAILED')
    },
  })
}

/**
 * Mount the real registry, optionally this plugin, and the fixtures.
 * @param config - plugin config; `undefined` mounts it with defaults.
 * @param options - `mount: false` is the control arm; `ask`/`program` choose the settlements.
 * @returns the context, the captured WARN messages, and the ask-started signal.
 */
export async function world(config = undefined, options = {}) {
  const ctx = new Context()
  const logged = []
  // `levels.default` is the highest level an exporter admits (2 = WARN).
  ctx.logger.exporter({ levels: { default: 2 }, export: (message) => { logged.push(message) } })
  // `both` because these suites must also make a model-direct call to a
  // non-program tool; under `ptc` that call is denied before the waterfall.
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime, { mode: 'both' })
  const started = deferred()
  await ctx.plugin(FakeProgramBackend, {
    behaviour: options.program ?? 'deadline',
    started,
  })
  if (options.mount !== false) {
    await ctx.plugin({
      name: plugin.name,
      apply: (inner) => { plugin.apply(inner, config ?? {}) },
      inject: plugin.inject,
    })
  }
  ctx.tools.register(askTool(options.ask ?? 'aborted', started))
  ctx.tools.register(decoyTool(ctx, started))
  return { ctx, logged, started }
}

/**
 * Run one call through the registry — the `tools/execute` waterfall this plugin
 * wraps, on the same path a model-direct call takes.
 * @param ctx - the mounted context.
 * @param options - `callId` reuses a call tree; `name` selects the tool.
 * @returns the settled tool result.
 */
export function runTool(ctx, options = {}) {
  return ctx.tools.execute({
    callId: ToolCallId(options.callId ?? 'call_root_1'),
    name: options.name ?? PROGRAM_TOOL,
    arguments: options.arguments ?? { code: 'await tools.ask_user_question({})', description: 'ask the user' },
    signal: new AbortController().signal,
  })
}

/**
 * The advisory contexts a result carries.
 * @param result - a settled tool result.
 * @returns the injected contexts this plugin owns.
 */
export function advisories(result) {
  return (result.additionalContexts ?? []).filter(message => message.source?.kind === 'ptc-ask-timeout-advisor')
}

/**
 * Render the captured records the way an exporter would — `%s` placeholders and
 * all — so a suite can assert on the line the host would actually read.
 * @param logged - the array `world()` returned.
 * @returns one string per captured record.
 */
export function logLines(logged, needle) {
  return logged
    .map(record => record.args.map(value => String(value)).join(' '))
    .filter(line => line.includes(needle))
}

/** The text of the first advisory, or `undefined` when there is none. */
export function advisoryTextOf(result) {
  const [first] = advisories(result)
  return first?.content?.map(block => block.text ?? '').join('')
}

/** The model-facing text of a settled result. */
export function textOf(result) {
  return (result.content ?? []).map(block => block.text ?? '').join('')
}
