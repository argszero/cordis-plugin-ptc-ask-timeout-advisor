#!/usr/bin/env node
/**
 * A `peerDependencies` range is a claim about versions nobody ran. This script
 * makes the claim checkable instead of asserted: for each line the range admits,
 * it copies this package into a scratch directory, pins every harness package to
 * that line, installs, builds, and runs the suite.
 *
 * The lines come from the manifest, not from a list here — a probe with its own
 * copy of the contract can drift from the thing it is supposed to be checking.
 * Each `||` segment of the range is one line, and its **latest published build**
 * is the representative: that is the build a user on that line is actually
 * running, and a line whose latest build passes is the strongest available
 * evidence for the whole segment (every earlier build of the tuple is the same
 * API with fewer fixes).
 *
 * ```sh
 * npm run test:probe-lines                 # every line the range admits
 * npm run test:probe-lines -- 0.1.7-rc.2   # one line
 * npm run test:probe-lines -- --keep       # leave the scratch trees in place
 * ```
 *
 * A line that fails here is removed from the range (manifest, README and the
 * `SUPPORTED`/`PROBED` contract in `test/packaging.spec.mjs`) rather than left
 * claimed. This script is development-only and is not published.
 *
 * @module scripts/probe-lines
 */

import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import semver from 'semver'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))

/** What is copied into the scratch tree; everything else is not needed to test. */
const COPIED = ['src', 'test', 'tsconfig.json', 'README.md', 'LICENSE', 'cordis.patch.yml']

/**
 * The harness packages installed at the probed line.
 *
 * All six are dependencies of this package's own development tree: the two the
 * peer range is about, plus the ones the integration suite mounts — the program
 * transport (`dsh-ptc-runtime`, and `dsh-ptc-runtime-node` for the deadline
 * literals the packaging suite reads back), the tool registry and its system
 * prompt, and the ask stack whose abort code is the plugin's evidence.
 */
const HARNESS = [
  '@deepseek-ai/dsh-llm',
  '@deepseek-ai/dsh-ptc-runtime',
  '@deepseek-ai/dsh-ptc-runtime-node',
  '@deepseek-ai/dsh-system-prompt',
  '@deepseek-ai/dsh-tools',
  '@deepseek-ai/dsh-user-questions',
]

/**
 * The newest published build of each `||` segment of a range.
 *
 * The representative of a line is its latest build — the one a user on that line
 * is actually running — not the earliest one the segment happens to admit. The
 * earliest build of a line is an alpha nobody is left on, and probing it says
 * less than probing the build the line converged to.
 * @param range - a semver range, composed of `||` segments.
 * @param versions - every published version of the package.
 * @returns one version per segment, in range order.
 */
function representativesOf(range, versions) {
  return range.split('||')
    .map(segment => segment.trim())
    .filter(segment => segment.length > 0)
    .map(segment => semver.maxSatisfying(versions, segment))
}

const argv = process.argv.slice(2)
const keep = argv.includes('--keep')
const requested = argv.filter(argument => !argument.startsWith('-'))

const range = manifest.peerDependencies['@deepseek-ai/dsh-tools']
const published = JSON.parse(execFileSync('npm', ['view', '@deepseek-ai/dsh-tools', 'versions', '--json'], { encoding: 'utf8' }))
const lines = requested.length > 0 ? requested : representativesOf(range, published)

/** Install one probe and run the suite in it. */
function probe(line) {
  const dir = mkdtempSync(join(tmpdir(), `ptc-ask-timeout-advisor-${line}-`))
  const log = (message) => process.stdout.write(`${message}\n`)
  log(`\n=== ${line} — ${dir}`)
  for (const entry of COPIED) cpSync(join(ROOT, entry), join(dir, entry), { recursive: true })
  writeFileSync(join(dir, 'package.json'), `${JSON.stringify({
    ...manifest,
    devDependencies: {
      ...manifest.devDependencies,
      ...Object.fromEntries(HARNESS.map(name => [name, line])),
    },
    // No `test:probe-lines` here: the probe must not be able to recurse.
    scripts: { build: 'tsc', test: 'tsc && node --test "test/*.spec.mjs"' },
  }, null, 2)}\n`)
  try {
    install(dir, log, line)
    execFileSync('node', [join(dir, 'node_modules', 'typescript', 'bin', 'tsc')], { cwd: dir, stdio: ['ignore', 'pipe', 'inherit'] })
    execFileSync('node', ['--test', 'test/*.spec.mjs'], { cwd: dir, stdio: ['ignore', 'pipe', 'inherit'] })
    log(`=== ${line}: PASS`)
    return true
  } catch (error) {
    if (error.stdout !== undefined) process.stdout.write(String(error.stdout))
    log(`=== ${line}: FAIL`)
    return false
  } finally {
    if (!keep) rmSync(dir, { recursive: true, force: true })
  }
}

/**
 * Install the probed line, and say so when npm's own resolution had to be
 * overruled.
 *
 * The harness packages peer-depend on each other, and a prerelease build can
 * peer-depend on a later rc of the same line, which npm refuses to resolve into
 * one tree. That refusal is a fact about the harness's published metadata, not
 * about this plugin — a real install gets these packages from the profile's own
 * lockfile — so the probe retries with `--force` and records that the line's tree
 * is npm's own choice. Only the LINE of the versions under test is pinned here;
 * which build of it npm ends up hoisting is not something this plugin's claim
 * depends on.
 * @param dir - the probe tree.
 * @param log - the progress writer.
 * @param line - the line being probed.
 */
function install(dir, log, line) {
  const options = { cwd: dir, stdio: ['ignore', 'ignore', 'inherit'] }
  try {
    execFileSync('npm', ['install', '--no-audit', '--no-fund'], options)
  } catch {
    log(`    npm refused the ${line} peer graph; retrying with --force`)
    execFileSync('npm', ['install', '--no-audit', '--no-fund', '--force'], options)
  }
}

const failed = lines.filter(line => !probe(line))
process.stdout.write(`\nprobed ${lines.length} line(s) of ${range}\n`)
if (failed.length > 0) {
  process.stdout.write(`failed: ${failed.join(', ')} — remove them from the range, the README and SUPPORTED\n`)
  process.exitCode = 1
}
