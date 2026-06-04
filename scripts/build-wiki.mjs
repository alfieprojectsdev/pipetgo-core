// build-wiki.mjs — generate GitHub wiki pages from in-repo docs.
//
// One-directional: the repo is the source of truth. Each generated page carries a
// banner pointing back at its source file and is overwritten on every publish, so
// the wiki is a read-only human mirror — never hand-edit a generated page.
//
// Usage: node scripts/build-wiki.mjs [outDir]   (default outDir: wiki-out)
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { execSync } from 'node:child_process'

const outDir = process.argv[2] || 'wiki-out'
mkdirSync(outDir, { recursive: true })

const repo = process.env.GITHUB_REPOSITORY || 'alfieprojectsdev/pipetgo-core'
const sha =
  process.env.GITHUB_SHA ||
  (() => {
    try {
      return execSync('git rev-parse HEAD').toString().trim()
    } catch {
      return 'HEAD'
    }
  })()

// repo file -> wiki page name. Wiki page "Foo-Bar" renders as a page titled "Foo Bar".
// Keep this list curated: only stable, human-facing docs belong on the wiki. Code-coupled
// docs (CLAUDE.md, per-slice READMEs, session notes) intentionally stay in-repo only.
const manifest = [
  { src: 'README.md', page: 'Home' },
  { src: 'docs/roadmap.md', page: 'Roadmap' },
  { src: 'docs/architecture/ADR-001-vertical-slice.md', page: 'Architecture-ADR-001-Vertical-Slice' },
  { src: 'docs/devops-discipline.md', page: 'DevOps-Readiness-Protocol' },
]

function banner(src) {
  const url = `https://github.com/${repo}/blob/main/${src}`
  return (
    `> ⚠️ **Generated page — do not edit here.**\n` +
    `> Source of truth: [\`${src}\`](${url}) @ \`${sha.slice(0, 7)}\`.\n` +
    `> Edit the repo file; this page is overwritten on every push to \`main\`.\n\n` +
    `---\n\n`
  )
}

const written = []
for (const { src, page } of manifest) {
  let body
  try {
    body = readFileSync(src, 'utf8')
  } catch {
    console.warn(`skip: ${src} not found`)
    continue
  }
  writeFileSync(`${outDir}/${page}.md`, banner(src) + body)
  written.push({ src, page })
  console.log(`wrote ${page}.md  <-  ${src}`)
}

// _Sidebar.md is a GitHub-wiki special page rendered on every page.
const sidebar =
  `### PipetGo V2\n\n` +
  written.map(({ page }) => `- [[${page}]]`).join('\n') +
  `\n\n_Pages are generated from the repo. Edit the source, not the wiki._\n`
writeFileSync(`${outDir}/_Sidebar.md`, sidebar)
console.log(`wrote _Sidebar.md (${written.length} pages)`)

if (written.length === 0) {
  console.error('no pages generated — check the manifest paths')
  process.exit(1)
}
