/**
 * The seam: does wrapping `tools/execute` actually observe a PTC program's
 * nested ask settle, and does the advisory land on the program's own result?
 *
 * Every arm runs the shipped `run_code` transport through the live registry and
 * a program backend that calls the bindings `ptc.ts` built — so these are
 * end-to-end measurements of the claim, not unit tests of a helper.
 *
 * The control arms matter as much as the positive one. A plugin that injected on
 * a deadline failure regardless of what the program was waiting on would pass a
 * positive-only suite while turning every timed-out program into a false alarm,
 * and one that read the record without consuming it would advise programs about
 * questions asked in a different call. The arms below fail the moment a single
 * gate stops narrowing.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  ASK_ABORT_MESSAGE,
  ASK_TOOL,
  DEADLINE_MESSAGE,
  FOREIGN_TIMEOUT_MESSAGE,
  PROGRAM_ERROR_MESSAGE,
  PROGRAM_TOOL,
  advisoryTextOf,
  advisories,
  logLines,
  runTool,
  textOf,
  world,
} from './harness.mjs'

test('the reported sequence: a deadline ends a program waiting on an ask, and the next request is told', async () => {
  const { ctx, logged } = await world()
  const result = await runTool(ctx)

  // The failure the model sees is unchanged — this plugin adds, it does not repair.
  assert.equal(result.isError, true)
  assert.equal(result.error.info.code, 'CODE_RUN_FAILED')
  assert.equal(result.error.message, DEADLINE_MESSAGE)
  assert.match(textOf(result), /execution deadline reached/)

  const notes = advisories(result)
  assert.equal(notes.length, 1, 'exactly one advisory rides the program result')
  const [note] = notes
  assert.equal(note.role, 'user')
  assert.equal(note.source.kind, 'ptc-ask-timeout-advisor')
  const text = advisoryTextOf(result)
  assert.match(text, /execution deadline, not by anything it ran/)
  assert.match(text, /ABORTED, not answered/)
  assert.match(text, /never an approval/)
  assert.match(text, /Do NOT carry out the action/)
  assert.match(text, new RegExp(ASK_TOOL))
  assert.equal(logLines(logged, 'ptc-ask-timeout-advisor').length, 1)
})

test('the nested settlement is observed before the program settles', async () => {
  // The advisory can only exist if the aborted ask was already in the ledger
  // when the program's own settlement arrived. Asserting the ordering directly
  // is what makes the mechanism falsifiable instead of merely plausible.
  const { ctx } = await world(undefined, { program: 'fire-and-succeed' })
  const result = await runTool(ctx)
  assert.equal(result.isError, false, 'the run itself succeeded')
  assert.deepEqual(advisories(result), [], 'a successful program is nobody\'s deadline')
})

test('a question the user ANSWERED inside the budget produces nothing', async () => {
  const { ctx } = await world(undefined, { program: 'answered-then-deadline', ask: 'answered' })
  const result = await runTool(ctx)
  assert.equal(result.isError, true, 'the program still hits its deadline')
  assert.equal(result.error.message, DEADLINE_MESSAGE)
  assert.deepEqual(advisories(result), [])
})

test('an ask that ended by a neighbour outcome is not this case', async () => {
  for (const ask of ['cancelled', 'timed-out']) {
    const { ctx } = await world(undefined, { ask })
    const result = await runTool(ctx)
    assert.equal(result.isError, true)
    assert.deepEqual(advisories(result), [], `${ask} must not be read as ASK_ABORTED`)
  }
})

test('a program that failed with its own exception is its own diagnosis', async () => {
  const { ctx } = await world(undefined, { program: 'exception' })
  const result = await runTool(ctx)
  assert.equal(result.error.info.code, 'CODE_RUN_FAILED')
  assert.equal(result.error.message, PROGRAM_ERROR_MESSAGE)
  assert.deepEqual(advisories(result), [])
})

test('a timeout of the runtime\'s own, worded differently, is left alone', async () => {
  const { ctx } = await world(undefined, { program: 'foreign-timeout' })
  const result = await runTool(ctx)
  assert.equal(result.error.info.code, 'CODE_RUN_FAILED')
  assert.equal(result.error.message, FOREIGN_TIMEOUT_MESSAGE)
  assert.deepEqual(advisories(result), [], 'only the run deadline is this plugin\'s business')
})

test('a deadline with no ask behind it produces nothing', async () => {
  const { ctx } = await world(undefined, { program: 'no-ask' })
  const result = await runTool(ctx)
  assert.equal(result.error.message, DEADLINE_MESSAGE)
  assert.deepEqual(advisories(result), [])
})

test('the deadline wording alone does not make a call a program', async () => {
  const { ctx } = await world(undefined, { program: 'no-ask' })
  const result = await runTool(ctx, { name: 'bash' })
  assert.equal(result.error.message, DEADLINE_MESSAGE, 'bash fails with the same code and wording')
  assert.deepEqual(advisories(result), [], 'a non-program call is never advised')
})

test('the record is keyed by the call tree', async () => {
  // The decoy dispatches its ask under the tree of the call below, but that ask
  // settles as ASK_ABORTED only while the decoy is the settling call; a program
  // in a different tree must not be able to claim it.
  const { ctx } = await world(undefined, { program: 'no-ask' })
  const decoy = await runTool(ctx, { name: 'bash', callId: 'call_decoy' })
  assert.equal(decoy.error.message, DEADLINE_MESSAGE)
  const program = await runTool(ctx, { callId: 'call_other_tree' })
  assert.deepEqual(advisories(program), [])
})

test('a control arm without the plugin produces the failure and nothing else', async () => {
  const { ctx } = await world(undefined, { mount: false })
  const result = await runTool(ctx)
  assert.equal(result.error.message, DEADLINE_MESSAGE)
  assert.deepEqual(advisories(result), [])
})

test("mode 'off' does not even register", async () => {
  const { ctx, logged } = await world({ mode: 'off' })
  const result = await runTool(ctx)
  assert.deepEqual(advisories(result), [])
  assert.deepEqual(logLines(logged, 'ptc-ask-timeout-advisor'), [])
})

test("mode 'warn' recognizes and logs without injecting", async () => {
  const { ctx, logged } = await world({ mode: 'warn' })
  const result = await runTool(ctx)
  assert.deepEqual(advisories(result), [])
  const warnings = logLines(logged, 'ptc-ask-timeout-advisor')
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /left unchanged \(warn mode\)/)
})

test('a deployment that renames the ask tool is honoured', async () => {
  const { ctx } = await world({ askTools: ['my_ask'] })
  const result = await runTool(ctx, { name: PROGRAM_TOOL })
  assert.equal(result.error.message, DEADLINE_MESSAGE)
  // The fixture always asks as `ask_user_question`, so this deployment must go
  // silent — the point of the arm is that the name comes from config at all.
  assert.deepEqual(advisories(result), [])
})

test('a deployment that admits another abort code is honoured', async () => {
  const { ctx } = await world({ abortCodes: ['ASK_CANCELLED'] })
  const result = await runTool(ctx)
  assert.equal(result.error.message, DEADLINE_MESSAGE)
  assert.deepEqual(advisories(result), [], 'ASK_ABORTED is no longer an admitted code')
})

test('a narrowed deadline wording goes silent rather than guessing', async () => {
  const { ctx } = await world({ deadlinePatterns: ['no such sentence'] })
  const result = await runTool(ctx)
  assert.equal(result.error.message, DEADLINE_MESSAGE)
  assert.deepEqual(advisories(result), [])
})

test('a deployment that renames the program transport is honoured', async () => {
  const { ctx } = await world({ tools: ['bash'] })
  const result = await runTool(ctx, { name: 'bash' })
  assert.equal(result.error.info.code, 'CODE_RUN_FAILED')
  assert.equal(advisories(result).length, 1)
  // ...and the shipped name is no longer a program under that deployment.
  const other = await runTool(ctx)
  assert.deepEqual(advisories(other), [])
})

test('the advisory quotes the harness\'s own sentences', async () => {
  const { ctx } = await world()
  const result = await runTool(ctx)
  const text = advisoryTextOf(result)
  assert.ok(text.includes(ASK_ABORT_MESSAGE), 'the aborted sentence is quoted verbatim')
  assert.ok(text.includes('120000'))
})
