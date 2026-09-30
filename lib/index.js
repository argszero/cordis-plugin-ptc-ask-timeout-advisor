/**
 * PTC ask-timeout advisor for the dsh harness.
 *
 * ## The gap (discussion #8368)
 *
 * In PTC mode the model can only call `run_code`, and a program that needs a
 * human decision asks through the generated SDK: `await tools.ask_user_question({…})`.
 * That program runs under a wall-clock deadline — `dsh-ptc-runtime-node`'s
 * `timeoutMs`, default **120 000 ms**, capped by `maxTimeoutMs` (default 600 000) —
 * and the deadline is documented as covering *everything* the program does:
 * *"Default elapsed deadline, including nested tool and approval waits."*
 * Waiting for a human is therefore spent out of the program's budget.
 *
 * When the budget expires while the question is still open, the sequence is
 *
 *   1. the run's abort reaches the nested call, which settles as
 *      `UserQuestionError` / `ASK_ABORTED` ("ask_user_question was aborted
 *      before the user answered"), and then
 *   2. `run_code` itself comes back as `CODE_RUN_FAILED` with the message
 *      `code run failed (timeout): execution deadline reached (120000ms)`.
 *
 * The model sees only step 2 — a program failure, indistinguishable from a
 * program that crashed — so nothing in what it reads says *"your question is
 * still unanswered; the user never saw an answer either"*. It steps forward as
 * if it had permission, which is exactly the danger the reporter names: the
 * deadline becomes an accidental consent. The ask tool's own contract says the
 * opposite in so many words — "A timeout is never approval" — and the report
 * measured the control that proves the difference: the same question asked as a
 * model-direct tool call (no program around it) waited over four minutes for a
 * real answer.
 *
 * ## What this plugin does
 *
 * It wraps the public `tools/execute` waterfall — the one seam that sees every
 * dispatch, including the nested sub-dispatches a `run_code` program makes,
 * because they go through the same registry pipeline — and keeps a ledger keyed
 * by the call tree's `rootCallId`:
 *
 *   * a settled dispatch of an ask tool (`askTools`, default
 *     `['ask_user_question']`) that failed with an abort code (`abortCodes`,
 *     default `['ASK_ABORTED']`) is recorded against the call tree, and
 *   * a settled PTC program (`tools`, default `['run_code']`) that failed with
 *     `codes` (default `['CODE_RUN_FAILED']`) **and** whose message matches
 *     `deadlinePatterns` (default `['execution deadline reached']`) takes that
 *     record and, when there is one, calls `exec.deferContext(…)` with a
 *     user-role advisory:
 *
 *     the question was aborted, not answered — it is pending, not permission;
 *     do not perform the action it was gating; ask it again as a direct tool
 *     call, outside the program, where no deadline is running; if the work
 *     cannot proceed without the answer, stop and hand it to the user.
 *
 * The advice rides the result the program already produced: `deferContext`
 * appends the message to the next request **after** the `tool/result`, so the
 * model reads a failure it understands *and* the fact the failure was hiding.
 * Nothing else changes — no request is re-sent, no sandbox is widened, no
 * session event is rewritten, and the transcript of the timed-out run stays
 * exactly as the harness recorded it.
 *
 * ## What it refuses
 *
 * Every gate is a narrowing this plugin would rather miss a case than misfire on:
 *
 * - **Only a PTC program.** The outer tool name must be in `tools`. A `bash`
 *   call that happens to fail with a deadline-shaped message is not a program.
 * - **Only the budget.** The failure code must be in `codes` *and* the message
 *   must match `deadlinePatterns`. A program that failed with `code run failed
 *   (error): …` — the program's own exception — is its own diagnosis and gets
 *   nothing from this plugin.
 * - **Only an aborted ask.** The nested dispatch's name must be in `askTools`,
 *   its result must be an error, and its code must be in `abortCodes`. An ask
 *   that was ANSWERED before the deadline (`ASK_TIMED_OUT` is a *different*
 *   outcome: the timed mode's own deadline settled it and the answer channel
 *   stays open) is not this case and is left alone.
 * - **Once per call tree.** The record is taken, not read, so a second program
 *   under the same root call cannot be advised about a question it never asked.
 *
 * `mode` follows the family habit: `advisory` (default) injects, `warn` only
 * logs, `off` unregisters the listener entirely.
 *
 * ## Honest boundary
 *
 * This is a stopgap for a design question the runtime's own documentation
 * carries as open — *"Execution is one-shot — no yield/wait API"* — and it does
 * not settle it. It does not stop the deadline, restore the program, or answer
 * the question; it removes the specific lie that "a program failed" is the whole
 * story. The preferred fix remains upstream: do not count human wait against a
 * program's execution budget, or surface the pending state in the program's own
 * result. The wording this plugin keys on (`execution deadline reached`,
 * `CODE_RUN_FAILED`, `ASK_ABORTED`) is the harness's, and is pinned against the
 * shipped bundles by `test/packaging.spec.mjs` for exactly that reason: if
 * upstream rewords one, this plugin stops matching and goes silent — the safe
 * direction — instead of adapting silently.
 *
 * @module @argszero/cordis-plugin-ptc-ask-timeout-advisor
 */
// Value import: the harness's own message constructor, so the injected context is
// a real user-role message with the identity semantics every consumer expects.
import { createUserMessage } from '@deepseek-ai/dsh-llm';
/** Cordis plugin name used by loader diagnostics. */
export const name = 'ptc-ask-timeout-advisor';
/** The tool registry whose `tools/execute` waterfall this plugin observes. */
export const inject = ['tools'];
/** The PTC transports whose deadline-cut failures carry the advisory. */
export const DEFAULT_TOOLS = Object.freeze(['run_code']);
/** The tools that ask a human, whose aborted settlements are the evidence. */
export const DEFAULT_ASK_TOOLS = Object.freeze(['ask_user_question']);
/** The failure code of a PTC program the runtime ended, including a deadline. */
export const DEFAULT_CODES = Object.freeze(['CODE_RUN_FAILED']);
/** The code an ask settles with when its waiting ended before an answer. */
export const DEFAULT_ABORT_CODES = Object.freeze(['ASK_ABORTED']);
/**
 * The runtime's own deadline wording.
 *
 * `ptc-runtime-node` writes it in two places — the abort reason it hands the
 * program (`controller.abort('execution deadline reached')`) and the failure
 * message it reports (`execution deadline reached (${timeoutMs}ms)`) — and this
 * plugin keys on the second. A runtime that rewords it stops matching here, and
 * the plugin goes silent rather than guessing that some other failure was a
 * budget cut.
 */
export const DEFAULT_DEADLINE_PATTERNS = Object.freeze(['execution deadline reached']);
/** Validate a non-empty string array, failing loud rather than silently ignoring a typo. */
function stringList(label, value, fallback) {
    if (value === undefined)
        return fallback;
    if (!Array.isArray(value) || value.length === 0) {
        throw new Error(`ptc-ask-timeout-advisor: \`${label}\` must be a non-empty array of strings`);
    }
    for (const entry of value) {
        if (typeof entry !== 'string' || entry.length === 0) {
            throw new Error(`ptc-ask-timeout-advisor: \`${label}\` must contain only non-empty strings`);
        }
    }
    return Object.freeze([...value]);
}
/**
 * Validate, default and compile one plugin config.
 *
 * Fail-loud on every field: a typo that silently disabled the advisor would look
 * exactly like the gap it exists to close.
 * @param config - the config as the loader passed it.
 * @returns the resolved config, safe to capture in the listener.
 */
export function resolveConfig(config = {}) {
    const mode = config.mode ?? 'advisory';
    if (mode !== 'advisory' && mode !== 'warn' && mode !== 'off') {
        throw new Error(`ptc-ask-timeout-advisor: \`mode\` must be "advisory", "warn" or "off" (got ${JSON.stringify(mode)})`);
    }
    const sources = stringList('deadlinePatterns', config.deadlinePatterns, DEFAULT_DEADLINE_PATTERNS);
    return Object.freeze({
        mode,
        tools: stringList('tools', config.tools, DEFAULT_TOOLS),
        askTools: stringList('askTools', config.askTools, DEFAULT_ASK_TOOLS),
        codes: stringList('codes', config.codes, DEFAULT_CODES),
        abortCodes: stringList('abortCodes', config.abortCodes, DEFAULT_ABORT_CODES),
        deadlinePatterns: Object.freeze(sources.map((source) => {
            try {
                return new RegExp(source);
            }
            catch (error) {
                throw new Error(`ptc-ask-timeout-advisor: \`deadlinePatterns\` entry ${JSON.stringify(source)} is not a valid regular expression`, { cause: error });
            }
        })),
    });
}
/** The structured code the registry recorded on a failed result, when there is one. */
function failureCode(result) {
    if (!result.isError)
        return undefined;
    const code = result.error.info?.code;
    return typeof code === 'string' && code.length > 0 ? code : undefined;
}
/** The message the registry recorded on a failed result. */
function failureMessage(result) {
    return result.error?.message ?? '';
}
/**
 * Whether one settled dispatch is a human question that ended unanswered.
 *
 * The identity of the failure is the **code**, not the wording or the tool: the
 * ask stack owns `ASK_ABORTED` for exactly this outcome (`abortedQuestion()` in
 * `dsh-user-questions`), and the code survives the registry's error projection
 * while the text is free to be reworded.
 * @param exec - the settled dispatch's identity.
 * @param result - its normalized result.
 * @param config - the resolved config.
 * @returns the record to keep, or `undefined` when this is not an aborted ask.
 */
export function abortedAskOf(exec, result, config) {
    if (!config.askTools.includes(exec.name))
        return undefined;
    const code = failureCode(result);
    if (code === undefined || !config.abortCodes.includes(code))
        return undefined;
    return { name: exec.name, code, message: failureMessage(result) };
}
/**
 * Whether one settled dispatch is a PTC program the run's own deadline ended.
 *
 * Three facts, all structural: it is a program, it failed, and it failed with a
 * code this plugin accepts *and* a message naming the deadline. The code alone is
 * not enough — `CODE_RUN_FAILED` is also what a program's own exception produces,
 * and that program needs no advice about a question nobody asked it.
 * @param exec - the settled dispatch's identity.
 * @param result - its normalized result.
 * @param config - the resolved config.
 * @returns whether this settlement is a deadline cut.
 */
export function isDeadlineFailure(exec, result, config) {
    if (!config.tools.includes(exec.name))
        return false;
    const code = failureCode(result);
    if (code === undefined || !config.codes.includes(code))
        return false;
    return config.deadlinePatterns.some((pattern) => pattern.test(failureMessage(result)));
}
/**
 * The aborted-yet-answered questions a call tree has left behind.
 *
 * Keyed by `rootCallId`, which the registry resolves for every root and nested
 * execution, so a nested sub-dispatch and the program that dispatched it land in
 * the same slot without this plugin having to know anything about PTC's own
 * bookkeeping. The slot is **taken**, never read: one program settlement consumes
 * the record, so a later program in the same tree cannot be advised about a
 * question it did not ask.
 *
 * A record whose program never settles — an ask aborted outside any program, or
 * a process that dies mid-run — would otherwise accumulate, so the ledger is
 * bounded and evicts its oldest entry (a Map iterates in insertion order).
 */
export class RunLedger {
    limit;
    notes = new Map();
    constructor(limit = 256) {
        this.limit = limit;
    }
    /** How many call trees currently hold an unclaimed record. */
    get size() {
        return this.notes.size;
    }
    /**
     * Record one aborted ask against its call tree.
     * @param rootCallId - the tree's root call.
     * @param ask - the aborted settlement.
     */
    note(rootCallId, ask) {
        if (!this.notes.has(rootCallId) && this.notes.size >= this.limit) {
            const oldest = this.notes.keys().next().value;
            if (oldest !== undefined)
                this.notes.delete(oldest);
        }
        this.notes.set(rootCallId, ask);
    }
    /**
     * Claim and clear the record for one call tree.
     * @param rootCallId - the tree's root call.
     * @returns the record, or `undefined` when this tree has none.
     */
    take(rootCallId) {
        const note = this.notes.get(rootCallId);
        this.notes.delete(rootCallId);
        return note;
    }
}
/** The run budget the reporter saw, quoted in the advisory. */
export const DEFAULT_BUDGET_MS = 120_000;
/** The cap the same runtime applies, quoted so the user-side knob is a real number. */
export const MAX_BUDGET_MS = 600_000;
/**
 * Build the user-role advisory behind a recognized pair.
 *
 * It is written for the model, not for a maintainer: what happened, what is now
 * true of the question, and what to do next — in that order, because the failure
 * it follows already told the model the opposite of the second point. No command
 * is offered and no tool is named that the failing composition might not mount;
 * the one action offered is a direct call to the tool that was already being
 * called, which is the reporter's own measured control.
 * @param ask - the aborted ask this program was waiting on.
 * @returns the advisory text.
 */
export function advisoryText(ask) {
    return [
        'The program was ended by its own execution deadline, not by anything it ran, and it was waiting on you at the time.',
        '',
        `A question was asked from inside the program (\`${ask.name}\`) and the run's wall-clock budget expired before it was answered. That question is`,
        `now ABORTED, not answered and not skipped — \`${ask.code}\`: "ask_user_question was aborted before the user answered". No answer exists.`,
        'A deadline is a limit on how long the program may run; it is never an approval, and it is not a decision by anyone.',
        '',
        `Why it happened: a program's budget covers everything it does, including waiting for a human — the runtime documents it as`,
        `"Default elapsed deadline, including nested tool and approval waits", default ${DEFAULT_BUDGET_MS} ms, capped at ${MAX_BUDGET_MS} ms.`,
        'Waiting on a person spends that budget, so an unanswered question can end the program.',
        '',
        'What to do:',
        '  1. Do NOT carry out the action that question was gating, and do not treat this failure as consent for it.',
        `  2. The question can still be answered: ask it again as a direct \`${ask.name}\` call, outside the program. A question asked that way is`,
        '     not on the program\'s clock and stays open until the user answers or cancels it.',
        '  3. If the work cannot go on without the answer, stop and hand it to the user.',
        '',
        'Nothing was lost: the aborted question and the program failure are both in the session log, and the program can be run again',
        'once an answer exists. If a specific program genuinely needs a longer budget, `ptc-runtime`\'s `timeoutMs` is the user-side knob.',
    ].join('\n');
}
/**
 * The advisor: observe every settled dispatch, keep the aborted asks, and tell a
 * program's next request what its failure left out.
 *
 * **Ordering is the whole mechanism.** The nested ask settles first — the
 * deadline aborts the run, the nested dispatch reaches quiescence, and only then
 * does the program's own result exist — so the record is always in the ledger by
 * the time the program's settlement is seen. Both settlements arrive through
 * this one waterfall because PTC sub-dispatches go through the same registry
 * pipeline as model-direct calls, which is what makes a plugin able to see them
 * at all.
 * @param source - the settled result from the next wrapper or the tool body.
 * @param exec - the execution identity that settled.
 * @param config - the resolved config.
 * @param ledger - the per-call-tree ledger.
 * @param onAdvise - called once per recognized pair, including in `warn` mode.
 * @returns the result, unchanged, plus (in `advisory` mode) one deferred context.
 */
export function adviseAboutAbortedAsk(source, exec, config, ledger, onAdvise) {
    const aborted = abortedAskOf(exec, source, config);
    if (aborted !== undefined) {
        ledger.note(exec.rootCallId, aborted);
        return source;
    }
    // Only a configured program may claim a record: a nested sub-dispatch settling
    // in the same tree must not consume the program's evidence on its way past.
    if (!config.tools.includes(exec.name))
        return source;
    const note = ledger.take(exec.rootCallId);
    if (note === undefined || !isDeadlineFailure(exec, source, config))
        return source;
    onAdvise?.({ ask: note, message: failureMessage(source), verdict: config.mode });
    if (config.mode === 'advisory') {
        exec.deferContext?.(createUserMessage({
            content: [{ type: 'text', text: advisoryText(note) }],
            source: { kind: 'ptc-ask-timeout-advisor' },
        }));
    }
    return source;
}
/**
 * Register the advisor.
 *
 * The wrapper delegates first and decides after: it never delays a dispatch, and
 * the context rides the result the program already produced. `deferContext` is
 * taken off the dispatch view (the registry's own execution object) because that
 * is where the registry reads the deferred contexts from — after this waterfall
 * returns, before the result is finalized — which is what lets a wrapper mint one
 * at all.
 * @param ctx - the Cordis context.
 * @param config - plugin config (defaults applied here, so a caller that builds
 *   its own config object — a profile layer, a test — gets the same behaviour as
 *   one that went through the loader).
 */
export function apply(ctx, config = {}) {
    const resolved = resolveConfig(config);
    if (resolved.mode === 'off')
        return;
    const ledger = new RunLedger();
    ctx.on('tools/execute', async (exec, next) => {
        const result = await next();
        const view = exec;
        return adviseAboutAbortedAsk(result, view, resolved, ledger, (evidence) => {
            ctx.logger.warn('ptc-ask-timeout-advisor: %s was ended by the run deadline while %s was still unanswered (%s); %s (discussion #8368)', exec.name, evidence.ask.name, evidence.ask.code, evidence.verdict === 'advisory'
                ? 'the program result now carries a user-role advisory saying so'
                : 'left unchanged (warn mode)');
        });
    });
}
