// @vitest-environment node

import { spawn } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const scriptPath = path.join(import.meta.dirname, 'build-preview-agent.ts')
const desktopDir = path.resolve(import.meta.dirname, '..')
const bundlePath = path.join(desktopDir, 'src-tauri', 'resources', 'preview-agent.js')
const rootManifestPath = path.resolve(desktopDir, '..', 'package.json')

function run(args: string[]): Promise<{ exitCode: number; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('bun', ['run', scriptPath, ...args], { cwd: desktopDir })
    let stderr = ''
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('error', reject)
    child.on('close', (code) => resolve({ exitCode: code ?? -1, stderr }))
  })
}

const restore: Array<() => Promise<void>> = []

async function preserve(file: string) {
  const original = await readFile(file)
  restore.push(async () => { await writeFile(file, original) })
  return original
}

afterEach(async () => {
  for (const undo of restore.splice(0).reverse()) await undo()
})

// Guarding the guard: `check:desktop` already rebuilt this bundle before
// `--check` existed, and silently threw the result away. A gate that cannot
// fail is the same class of bug it is meant to catch.
//
// Every case builds its own baseline rather than trusting the committed bundle
// to be fresh: minifier output varies across Bun releases, so asserting the
// checked-in file matches would test the machine's Bun version instead of this
// script. That the *committed* bundle is current is what `check:desktop`
// asserts in CI, where the pinned Bun is the one that produced it.
describe('preview-agent staleness check', () => {
  function runningBunVersion(): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn('bun', ['--version'])
      let stdout = ''
      child.stdout.on('data', (chunk) => { stdout += chunk })
      child.on('error', reject)
      child.on('close', () => resolve(stdout.trim()))
    })
  }

  async function writeFreshBundle() {
    await preserve(bundlePath)
    expect((await run([])).exitCode).toBe(0)
  }

  async function staleBundle() {
    const stale = `${await readFile(bundlePath, 'utf8')}\n// drift\n`
    await writeFile(bundlePath, stale)
    return stale
  }

  // The pin decides which of the two failure messages applies, so each case
  // sets it explicitly instead of depending on the Bun this machine happens to
  // have installed.
  async function pinManifestTo(version: string) {
    const manifest = JSON.parse((await preserve(rootManifestPath)).toString())
    await writeFile(
      rootManifestPath,
      `${JSON.stringify({ ...manifest, packageManager: `bun@${version}` }, null, 2)}\n`,
    )
  }

  it('passes when the bundle matches what the sources build', async () => {
    await writeFreshBundle()

    expect((await run(['--check'])).exitCode).toBe(0)
  }, 120_000)

  it('fails and names the fix when the bundle is stale', async () => {
    await writeFreshBundle()
    await pinManifestTo(await runningBunVersion())
    await staleBundle()

    const { exitCode, stderr } = await run(['--check'])

    expect(exitCode).toBe(1)
    expect(stderr).toContain('bun run build:preview-agent')
  }, 120_000)

  // Without this the failure reads "stale, go rebuild and commit", which on an
  // unpinned machine walks the developer into committing a bundle that the next
  // pinned build churns straight back.
  it('blames the Bun version rather than the sources when the pin does not match', async () => {
    await writeFreshBundle()
    await pinManifestTo('0.0.0-not-installed')
    await staleBundle()

    const { exitCode, stderr } = await run(['--check'])

    expect(exitCode).toBe(1)
    expect(stderr).toContain('0.0.0-not-installed')
    expect(stderr).not.toContain('bun run build:preview-agent')
  }, 120_000)

  it('never rewrites the bundle it found stale', async () => {
    await writeFreshBundle()
    const stale = await staleBundle()

    await run(['--check'])

    expect(await readFile(bundlePath, 'utf8')).toBe(stale)
  }, 120_000)
})
