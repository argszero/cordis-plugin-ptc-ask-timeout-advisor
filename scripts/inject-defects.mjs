/**
 * Defect injection: mutate the source, rebuild, run the suite, and require that
 * the mutation is caught. An arm whose mutation leaves the suite green is
 * SILENT — it proves nothing, and is reported as such.
 *
 * The suites import `lib/*.js`, not `src/*.ts`, so every arm rebuilds with tsc
 * first; a mutation that fails to type-check proves nothing either and is
 * reported separately.
 *
 * Three of the arms mutate published *prose* (the manifest, the README, the
 * bundle patch) rather than TypeScript: those claims live in files no compiler
 * reads, and `packaging.spec.mjs` is the only thing standing between them and a
 * release.
 *
 * Run from the plugin root: `npm run test:inject`.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const MUTATIONS = [
  {
    name: "mode 'off' registers the listener anyway, so a deployment that asked for silence still logs",
    file: 'src/index.ts',
    arms: 'seam.spec.mjs',
    edits: [['  if (resolved.mode === \'off\') return', '  if (resolved.mode === \'off\') { /* registers anyway */ }']],
  },
  {
    name: 'any abort code is accepted, so a cancellation is read as an unanswered question',
    file: 'src/index.ts',
    arms: 'seam.spec.mjs',
    edits: [['  if (code === undefined || !config.abortCodes.includes(code)) return undefined', '  if (code === undefined) return undefined']],
  },
  {
    name: 'the ask gate is dropped, so any tool that fails with the abort code is a question',
    file: 'src/index.ts',
    arms: 'advice.spec.mjs',
    edits: [['  if (!config.askTools.includes(exec.name)) return undefined', '  /* any tool\'s abort is a question */']],
  },
  {
    name: 'the deadline wording is no longer required, so a foreign timeout reads as the run budget',
    file: 'src/index.ts',
    arms: 'seam.spec.mjs',
    edits: [['  return config.deadlinePatterns.some((pattern) => pattern.test(failureMessage(result)))', '  return true']],
  },
  {
    name: 'the program-name gate is dropped from the classifier, so `bash` is a program',
    file: 'src/index.ts',
    arms: 'advice.spec.mjs',
    edits: [['  if (!config.tools.includes(exec.name)) return false', '  /* any tool may be a program */']],
  },
  {
    name: 'a nested settlement may claim the record, so a sibling call eats the program\'s evidence',
    file: 'src/index.ts',
    arms: 'advice.spec.mjs',
    edits: [[
      '  if (!config.tools.includes(exec.name)) return source\n  const note = ledger.take(exec.rootCallId)',
      '  const note = ledger.take(exec.rootCallId)',
    ]],
  },
  {
    name: 'the failure code is no longer required, so a neighbour code with the right wording matches',
    file: 'src/index.ts',
    arms: 'advice.spec.mjs',
    edits: [['  if (code === undefined || !config.codes.includes(code)) return false', '  if (code === undefined) return false']],
  },
  {
    name: 'the ledger reads instead of taking, so the same tree is advised twice',
    file: 'src/index.ts',
    arms: 'advice.spec.mjs',
    edits: [[
      '    const note = this.notes.get(rootCallId)\n    this.notes.delete(rootCallId)\n    return note',
      '    return this.notes.get(rootCallId)',
    ]],
  },
  {
    name: 'the ledger bound is off by one, so one more unsettled tree accumulates',
    file: 'src/index.ts',
    arms: 'advice.spec.mjs',
    edits: [['    if (!this.notes.has(rootCallId) && this.notes.size >= this.limit) {', '    if (!this.notes.has(rootCallId) && this.notes.size > this.limit) {']],
  },
  {
    name: 'the advisory stops saying a deadline is not an approval',
    file: 'src/index.ts',
    arms: 'advice.spec.mjs',
    edits: [[
      "    'A deadline is a limit on how long the program may run; it is never an approval, and it is not a decision by anyone.',",
      "    'A deadline is a limit on how long the program may run.',",
    ]],
  },
  {
    name: 'the advisory softens "aborted" into "timed out", losing that no answer exists',
    file: 'src/index.ts',
    arms: 'advice.spec.mjs',
    edits: [[
      '`now ABORTED, not answered and not skipped — \\`${ask.code}\\`',
      '`now timed out — \\`${ask.code}\\`',
    ]],
  },
  {
    name: 'the advisory loses the one action that works: re-asking outside the program',
    file: 'src/index.ts',
    arms: 'advice.spec.mjs',
    edits: [[
      "    `  2. The question can still be answered: ask it again as a direct \\`${ask.name}\\` call, outside the program. A question asked that way is`,",
      "    '  2. The question cannot be recovered in this run.',",
    ]],
  },
  {
    name: 'the budget quoted to the model is not the shipped default',
    file: 'src/index.ts',
    arms: 'advice.spec.mjs',
    edits: [['export const DEFAULT_BUDGET_MS = 120_000', 'export const DEFAULT_BUDGET_MS = 300_000']],
  },
  {
    name: 'the program transport default is not the shipped tool name',
    file: 'src/index.ts',
    arms: 'advice.spec.mjs',
    edits: [["export const DEFAULT_TOOLS: readonly string[] = Object.freeze(['run_code'])", "export const DEFAULT_TOOLS: readonly string[] = Object.freeze(['run'])"]],
  },
  {
    name: 'a manifest typo no longer fails loud, it silently falls back to the default',
    file: 'src/index.ts',
    arms: 'advice.spec.mjs',
    edits: [['  if (!Array.isArray(value) || value.length === 0) {', '  if (!Array.isArray(value)) {']],
  },
  {
    name: 'an unknown mode is accepted, so a deployment typo disables the advisor in silence',
    file: 'src/index.ts',
    arms: 'advice.spec.mjs',
    edits: [["  if (mode !== 'advisory' && mode !== 'warn' && mode !== 'off') {", '  if (false) {']],
  },
  {
    name: 'a blank entry in a list is accepted',
    file: 'src/index.ts',
    arms: 'advice.spec.mjs',
    edits: [["    if (typeof entry !== 'string' || entry.length === 0) {", "    if (typeof entry !== 'string') {"]],
  },
  {
    name: 'an uncompilable deadline pattern is not reported as the config error it is',
    file: 'src/index.ts',
    arms: 'advice.spec.mjs',
    edits: [[
      '    deadlinePatterns: Object.freeze(sources.map((source) => {\n'
      + '      try {\n'
      + '        return new RegExp(source)\n'
      + '      } catch (error) {\n'
      + '        throw new Error(`ptc-ask-timeout-advisor: \\`deadlinePatterns\\` entry ${JSON.stringify(source)} is not a valid regular expression`, { cause: error })\n'
      + '      }\n'
      + '    })),',
      '    deadlinePatterns: Object.freeze(sources.map((source) => new RegExp(source))),',
    ]],
  },
  {
    name: 'the lists are no longer frozen, so a captured config can be edited after mount',
    file: 'src/index.ts',
    arms: 'advice.spec.mjs',
    edits: [[
      '  return Object.freeze([...value])',
      '  return [...value]',
    ]],
  },
  {
    name: 'warn mode injects as well as logging, so the measuring mode is not inert',
    file: 'src/index.ts',
    arms: 'advice.spec.mjs',
    edits: [["  if (config.mode === 'advisory') {", "  if (config.mode !== 'off') {"]],
  },
  {
    name: 'the recognition line is logged under a name the operator cannot grep for',
    file: 'src/index.ts',
    arms: 'seam.spec.mjs',
    edits: [["        'ptc-ask-timeout-advisor: %s was ended by the run deadline while %s was still unanswered (%s); %s (discussion #8368)',", "        'advisor: %s was ended by the run deadline while %s was still unanswered (%s); %s (discussion #8368)',"]],
  },
  {
    name: 'the README quotes a lower bound the manifest does not ship',
    file: 'README.md',
    arms: 'packaging.spec.mjs',
    edits: [[
      '* `@deepseek-ai/dsh-llm` `>=0.1.7-alpha.1 <0.2.0 || >=0.2.0-rc.1 <0.3.0`',
      '* `@deepseek-ai/dsh-llm` `^0.1.7`',
    ]],
  },
  {
    name: 'the patch drops out of `files`, so the install has nothing to mount',
    file: 'package.json',
    arms: 'packaging.spec.mjs',
    edits: [['    "cordis.patch.yml",', '    "cordis.patch.prod.yml",']],
  },
  {
    name: 'the peer range widens past the tuple it was run on',
    file: 'package.json',
    arms: 'packaging.spec.mjs',
    edits: [['">=0.1.7-alpha.1 <0.2.0 || >=0.2.0-rc.1 <0.3.0"', '">=0.1.6-alpha.1 <0.2.0 || >=0.2.0-rc.1 <0.3.0"']],
  },
  {
    name: 'the declared bundle patch does not exist',
    file: 'package.json',
    arms: 'packaging.spec.mjs',
    edits: [['"patch": "./cordis.patch.yml"', '"patch": "./cordis.patch.yaml"']],
  },
  {
    name: 'the mount row names a package that is not this one',
    file: 'cordis.patch.yml',
    arms: 'packaging.spec.mjs',
    edits: [["    name: '@argszero/cordis-plugin-ptc-ask-timeout-advisor'", "    name: '@argszero/cordis-plugin-sandbox-grant-advisor'"]],
  },
  {
    // EQUIVALENT MUTANT, recorded rather than hidden: the registry's normalized
    // result carries `error` exactly when `isError` is true, so reading the
    // presence of `error` and reading `isError` are indistinguishable from
    // outside and no fixture can tell them apart. Kept in the list because "we
    // tried to make this arm bite and could not" is a fact about the arm, not a
    // reason to omit it.
    name: 'the settled-success check reads the error field instead of the flag',
    file: 'src/index.ts',
    arms: 'advice.spec.mjs',
    equivalent: 'the registry sets `error` exactly when `isError` is true, so the two reads agree on every fixture',
    edits: [[
      '  if (!result.isError) return undefined\n  const code: unknown = result.error.info?.code',
      '  if (result.error === undefined) return undefined\n  const code: unknown = result.error.info?.code',
    ]],
  },
]

let silent = 0
let unbuildable = 0
let skipped = 0
let caught = 0
let equivalent = 0

for (const mutation of MUTATIONS) {
  const path = join(ROOT, mutation.file)
  const original = readFileSync(path, 'utf8')
  let mutated = original
  let anchored = true
  for (const [find, replace] of mutation.edits) {
    if (!original.includes(find)) {
      anchored = false
      console.log(`SKIP (anchor missing): ${mutation.name}`)
    }
    mutated = mutated.replace(find, replace)
  }
  if (!anchored) {
    skipped += 1
    continue
  }

  const build = () => {
    try {
      execFileSync('node', [join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc')], { cwd: ROOT, stdio: 'pipe' })
      return true
    } catch {
      return false
    }
  }

  writeFileSync(path, mutated)
  let built = false
  let failed = false
  let output = ''
  try {
    built = build()
    if (built) {
      try {
        execFileSync('node', ['--test', `test/${mutation.arms}`], { cwd: ROOT, stdio: 'pipe' })
      } catch (error) {
        failed = true
        output = String(error.stdout ?? '') + String(error.stderr ?? '')
      }
    }
  } finally {
    // The source is restored and rebuilt whatever happened: an injector that can
    // leave a mutation in the tree is worse than no injector.
    writeFileSync(path, original)
    build()
  }

  if (!built) {
    unbuildable += 1
    console.log(`UNBUILDABLE (proves nothing): ${mutation.name}`)
    continue
  }
  const bitten = failed && new RegExp('fail [1-9]').test(output)
  const label = bitten ? 'CAUGHT' : mutation.equivalent === undefined ? 'SILENT' : 'EQUIVALENT'
  if (bitten) caught += 1
  else if (mutation.equivalent === undefined) silent += 1
  else equivalent += 1
  console.log(`${label}: ${mutation.name} (${mutation.arms})${bitten || mutation.equivalent === undefined ? '' : ` — ${mutation.equivalent}`}`)
}

console.log(`\nCAUGHT: ${caught}; EQUIVALENT: ${equivalent}; SILENT: ${silent === 0 ? 'none' : String(silent)}; UNBUILDABLE: ${unbuildable}; SKIPPED (anchor missing): ${skipped}`)
if (silent > 0 || unbuildable > 0 || skipped > 0) {
  console.log('a SILENT, UNBUILDABLE or SKIPPED arm is an assertion nobody has tested')
  process.exitCode = 1
}
