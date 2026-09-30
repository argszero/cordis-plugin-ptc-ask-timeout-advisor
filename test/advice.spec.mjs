/**
 * The decisions, tested without a registry.
 *
 * The seam suite proves the plugin sees the right traffic; this one proves the
 * individual gates are the ones its documentation claims, including the
 * fail-loud validation a deployment typo would otherwise slip past.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  DEFAULT_ABORT_CODES,
  DEFAULT_ASK_TOOLS,
  DEFAULT_BUDGET_MS,
  DEFAULT_CODES,
  DEFAULT_DEADLINE_PATTERNS,
  DEFAULT_TOOLS,
  MAX_BUDGET_MS,
  RunLedger,
  abortedAskOf,
  advisoryText,
  adviseAboutAbortedAsk,
  isDeadlineFailure,
  resolveConfig,
} from '../lib/index.js'

/** A settled result shaped the way the registry builds one. */
function failure(code, message) {
  return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true, error: { message, info: { name: 'x', code } } }
}

/** A settled success. */
const success = { content: [], isError: false }

/** One dispatch identity, plus a `deferContext` recorder. */
function exec(name, rootCallId = 'call_1') {
  const deferred = []
  return { name, callId: `${rootCallId}:n`, rootCallId, deferred, deferContext: (context) => { deferred.push(context) } }
}

const ASK_ABORTED = failure('ASK_ABORTED', 'ask_user_question was aborted before the user answered')
const DEADLINE = failure('CODE_RUN_FAILED', 'code run failed (timeout): execution deadline reached (120000ms)')

test('the shipped defaults are the harness\'s own names', () => {
  assert.deepEqual(DEFAULT_TOOLS, ['run_code'])
  assert.deepEqual(DEFAULT_ASK_TOOLS, ['ask_user_question'])
  assert.deepEqual(DEFAULT_CODES, ['CODE_RUN_FAILED'])
  assert.deepEqual(DEFAULT_ABORT_CODES, ['ASK_ABORTED'])
  assert.deepEqual(DEFAULT_DEADLINE_PATTERNS, ['execution deadline reached'])
  assert.equal(DEFAULT_BUDGET_MS, 120_000)
  assert.equal(MAX_BUDGET_MS, 600_000)
})

test('resolveConfig materializes every default and freezes the result', () => {
  const resolved = resolveConfig()
  assert.equal(resolved.mode, 'advisory')
  assert.deepEqual(resolved.tools, ['run_code'])
  assert.ok(Object.isFrozen(resolved))
  // The default lists are frozen constants at module scope, so they would answer
  // for this claim on the default path even if `stringList` stopped freezing.
  // A config-provided list is the one that proves the freeze is `stringList`'s.
  assert.ok(Object.isFrozen(resolveConfig({ tools: ['t'] }).tools), 'a configured list is frozen too')
  assert.ok(Object.isFrozen(resolved.tools))
  assert.equal(resolved.deadlinePatterns[0].test('x execution deadline reached (1ms)'), true)
})

test('resolveConfig fails loud on a typo instead of silently disabling the advisor', () => {
  assert.throws(() => resolveConfig({ mode: 'advice' }), /`mode` must be "advisory", "warn" or "off"/)
  assert.throws(() => resolveConfig({ tools: [] }), /`tools` must be a non-empty array of strings/)
  assert.throws(() => resolveConfig({ askTools: [''] }), /`askTools` must contain only non-empty strings/)
  assert.throws(() => resolveConfig({ abortCodes: 'ASK_ABORTED' }), /`abortCodes` must be a non-empty array/)
  assert.throws(() => resolveConfig({ deadlinePatterns: ['('] }), /is not a valid regular expression/)
})

test('a blank code is not a code', () => {
  assert.equal(abortedAskOf(exec('ask_user_question'), failure('', 'x'), resolveConfig()), undefined)
  assert.equal(abortedAskOf(exec('ask_user_question'), success, resolveConfig()), undefined)
})

test('an aborted ask is recognized by code, not by wording or tool identity', () => {
  const config = resolveConfig()
  const note = abortedAskOf(exec('ask_user_question'), ASK_ABORTED, config)
  assert.deepEqual(note, {
    name: 'ask_user_question',
    code: 'ASK_ABORTED',
    message: 'ask_user_question was aborted before the user answered',
  })
  // Reworded, same code: still recognized — the code is the identity.
  const reworded = abortedAskOf(exec('ask_user_question'), failure('ASK_ABORTED', 'whatever'), config)
  assert.equal(reworded.message, 'whatever')
  assert.equal(abortedAskOf(exec('other'), ASK_ABORTED, config), undefined)
})

test('a deadline failure needs all three facts', () => {
  const config = resolveConfig()
  assert.equal(isDeadlineFailure(exec('run_code'), DEADLINE, config), true)
  // Wrong tool.
  assert.equal(isDeadlineFailure(exec('bash'), DEADLINE, config), false)
  // Right code, wrong wording.
  assert.equal(isDeadlineFailure(exec('run_code'), failure('CODE_RUN_FAILED', 'compute budget exhausted'), config), false)
  // Right wording, wrong code.
  assert.equal(isDeadlineFailure(exec('run_code'), failure('CODE_RUN_FAILEDX', 'execution deadline reached'), config), false)
  // A neighbour code entirely.
  assert.equal(isDeadlineFailure(exec('run_code'), failure('ABORTED', 'execution deadline reached'), config), false)
})

test('the ledger takes rather than reads, and stays bounded', () => {
  const ledger = new RunLedger(2)
  const note = { name: 'ask_user_question', code: 'ASK_ABORTED', message: 'm' }
  ledger.note('a', note)
  ledger.note('b', note)
  ledger.note('c', note)
  assert.equal(ledger.size, 2, 'the oldest entry is evicted')
  assert.equal(ledger.take('a'), undefined)
  const taken = ledger.take('c')
  assert.equal(taken, note)
  assert.equal(ledger.take('c'), undefined, 'a record is consumed, never re-read')
})

test('a later record for the same tree replaces the earlier one', () => {
  const ledger = new RunLedger()
  ledger.note('a', { name: 'one', code: 'ASK_ABORTED', message: '1' })
  ledger.note('a', { name: 'two', code: 'ASK_ABORTED', message: '2' })
  assert.equal(ledger.size, 1)
  assert.equal(ledger.take('a').name, 'two')
})

test('the advisory says what happened, what is now true, and what to do', () => {
  const text = advisoryText({ name: 'ask_user_question', code: 'ASK_ABORTED', message: 'm' })
  assert.match(text, /ask_user_question was aborted before the user answered/)
  assert.match(text, /ABORTED, not answered and not skipped/)
  assert.match(text, /never an approval/)
  assert.match(text, /Do NOT carry out the action that question was gating/)
  assert.match(text, /outside the program/)
  assert.match(text, new RegExp(`default ${DEFAULT_BUDGET_MS} ms, capped at ${MAX_BUDGET_MS} ms`))
  assert.match(text, /stop and hand it to the user/)
})

test('an aborted ask is recorded and passed through untouched', () => {
  const config = resolveConfig()
  const ledger = new RunLedger()
  const asked = exec('ask_user_question')
  const returned = adviseAboutAbortedAsk(ASK_ABORTED, asked, config, ledger)
  assert.equal(returned, ASK_ABORTED)
  assert.deepEqual(asked.deferred, [])
  assert.equal(ledger.size, 1)
})

test('a deadline settlement claims the record and defers one user message', () => {
  const config = resolveConfig()
  const ledger = new RunLedger()
  adviseAboutAbortedAsk(ASK_ABORTED, exec('ask_user_question'), config, ledger)
  const program = exec('run_code')
  const seen = []
  const returned = adviseAboutAbortedAsk(DEADLINE, program, config, ledger, evidence => seen.push(evidence))
  assert.equal(returned, DEADLINE, 'the result is returned unchanged')
  assert.equal(program.deferred.length, 1)
  const [context] = program.deferred
  assert.equal(context.role, 'user')
  assert.equal(context.source.kind, 'ptc-ask-timeout-advisor')
  assert.match(context.content[0].text, /ABORTED, not answered/)
  assert.equal(ledger.size, 0)
  assert.equal(seen.length, 1)
  assert.equal(seen[0].verdict, 'advisory')
  assert.equal(seen[0].ask.code, 'ASK_ABORTED')
})

test('the record is consumed once, so no second program is advised about it', () => {
  const config = resolveConfig()
  const ledger = new RunLedger()
  adviseAboutAbortedAsk(ASK_ABORTED, exec('ask_user_question'), config, ledger)
  const first = exec('run_code')
  adviseAboutAbortedAsk(DEADLINE, first, config, ledger)
  assert.equal(first.deferred.length, 1)
  const second = exec('run_code')
  adviseAboutAbortedAsk(DEADLINE, second, config, ledger)
  assert.deepEqual(second.deferred, [], 'the tree cannot be advised twice')
})

test('a program that settles without a deadline still claims its tree record', () => {
  const config = resolveConfig()
  const ledger = new RunLedger()
  adviseAboutAbortedAsk(ASK_ABORTED, exec('ask_user_question'), config, ledger)
  assert.equal(ledger.size, 1)
  const program = exec('run_code')
  adviseAboutAbortedAsk(success, program, config, ledger)
  assert.equal(ledger.size, 0, 'the record is taken by its own program, not by a later one')
  assert.deepEqual(program.deferred, [])
})

test('a nested settlement in another tool never consumes the program\'s record', () => {
  const config = resolveConfig()
  const ledger = new RunLedger()
  adviseAboutAbortedAsk(ASK_ABORTED, exec('ask_user_question'), config, ledger)
  // A sibling nested dispatch (say, a `bash` the program ran) settles first.
  adviseAboutAbortedAsk(success, exec('bash'), config, ledger)
  assert.equal(ledger.size, 1, 'the record survives a foreign settlement')
  const program = exec('run_code')
  adviseAboutAbortedAsk(DEADLINE, program, config, ledger)
  assert.equal(program.deferred.length, 1)
})

test("warn mode recognizes the pair and injects nothing", () => {
  const config = resolveConfig({ mode: 'warn' })
  const ledger = new RunLedger()
  adviseAboutAbortedAsk(ASK_ABORTED, exec('ask_user_question'), config, ledger)
  const program = exec('run_code')
  const seen = []
  adviseAboutAbortedAsk(DEADLINE, program, config, ledger, evidence => seen.push(evidence))
  assert.deepEqual(program.deferred, [])
  assert.equal(seen.length, 1)
  assert.equal(seen[0].verdict, 'warn')
})

test('a dispatch view without deferContext is survived, not thrown on', () => {
  // `deferContext` lives on the registry's own execution object; a wrapper sees
  // it at runtime but is typed without it. Assert the optional call is optional.
  const config = resolveConfig()
  const ledger = new RunLedger()
  adviseAboutAbortedAsk(ASK_ABORTED, exec('ask_user_question'), config, ledger)
  const bare = { name: 'run_code', callId: 'c', rootCallId: 'call_1' }
  assert.equal(adviseAboutAbortedAsk(DEADLINE, bare, config, ledger), DEADLINE)
  assert.equal(ledger.size, 0)
})
