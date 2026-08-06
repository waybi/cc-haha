import { $ } from 'bun'
import { readFile, rename, rm } from 'node:fs/promises'

const outfile = './src-tauri/resources/preview-agent.js'
const tmpfile = `${outfile}.${process.pid}.tmp`

// The bundle is committed and shipped (electron-builder's `files` allowlist),
// so a stale one means the packaged app runs preview code that no longer
// matches `src/preview-agent/`. `--check` turns "I had to rewrite it" into a
// failure, which is what CI wants: it rebuilds on every `check:desktop` run
// but would otherwise discard the result and pass.
const checkOnly = process.argv.includes('--check')

// The minifier's output shifts between Bun releases, so a mismatch means one of
// two very different things: the sources changed, or this machine's Bun is not
// the one the committed bundle was built with. Only the first is a real defect,
// and telling them apart is what keeps a developer on an older Bun from
// "fixing" the failure by committing their own downgraded bundle.
async function pinnedBunVersion(): Promise<string | null> {
  try {
    const root = JSON.parse(await readFile('../package.json', 'utf8')) as {
      packageManager?: string
    }
    return root.packageManager?.match(/^bun@(.+)$/)?.[1] ?? null
  } catch {
    return null
  }
}

await $`bun build ./src/preview-agent/index.ts --outfile=${tmpfile} --format=iife --minify`

try {
  const [current, next] = await Promise.all([
    readFile(outfile),
    readFile(tmpfile),
  ])
  if (current.equals(next)) {
    await rm(tmpfile, { force: true })
    console.log('preview-agent.js unchanged')
    process.exit(0)
  }
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
    await rm(tmpfile, { force: true })
    throw error
  }
}

if (checkOnly) {
  await rm(tmpfile, { force: true })
  const pinned = await pinnedBunVersion()
  if (pinned && pinned !== Bun.version) {
    console.error(
      `${outfile} does not match a build from Bun ${Bun.version}, but this repo pins Bun ${pinned}.\n` +
      'Install the pinned version before trusting this result — minifier output varies between releases,\n' +
      'so committing a bundle built here would churn the file back on the next pinned build.',
    )
  } else {
    console.error(
      `${outfile} is stale. Run \`bun run build:preview-agent\` and commit the result.`,
    )
  }
  process.exit(1)
}

await rename(tmpfile, outfile)
console.log('preview-agent.js built')
