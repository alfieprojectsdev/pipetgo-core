# Wiki publishing (one-way mirror)

The repo is the **source of truth** for all documentation. The GitHub wiki is a
read-only, generated mirror of a curated subset, for a human-facing front door.

- **Workflow:** `.github/workflows/publish-wiki.yml` runs on every push to `main`
  that touches a published source (or via manual `workflow_dispatch`).
- **Generator:** `scripts/build-wiki.mjs` reads the curated `manifest`, prepends a
  "do not edit here" banner linking the source file + commit, and writes pages to
  `wiki-out/`. The workflow clones `…/pipetgo-core.wiki.git` and pushes the pages.
- **Direction:** one-way only. Generated pages are overwritten each run; never
  hand-edit a generated wiki page — edit the repo source.

## Published pages (the manifest)

| Wiki page | Source file |
| --------- | ----------- |
| `Home` | `README.md` |
| `Roadmap` | `docs/roadmap.md` |
| `Architecture-ADR-001-Vertical-Slice` | `docs/architecture/ADR-001-vertical-slice.md` |
| `DevOps-Readiness-Protocol` | `docs/devops-discipline.md` |

To add/remove a page, edit the `manifest` array in `scripts/build-wiki.mjs`.

**Intentionally NOT published** (code-coupled / tooling-loaded — must stay in-repo):
`CLAUDE.md` files, per-slice `README.md`s, `docs/sessions/*`, ADR state dumps.

## One-time setup

The `…​.wiki.git` repo does not exist until the wiki has at least one page. Before the
first run: repo → **Wiki** → **Create the first page** (any content — it will be
overwritten). After that the workflow pushes on every qualifying merge. Auth uses the
default `GITHUB_TOKEN` (the workflow grants it `contents: write`); no secret needed.

Run it by hand anytime from the **Actions** tab → *Publish docs to wiki* → *Run workflow*.

## Caveats

- Repo-relative links inside the mirrored pages (e.g. `src/...`) do not resolve on the
  wiki; the banner links back to the source file as the canonical view.
- The sync is additive — it overwrites the pages it generates and leaves any other wiki
  pages untouched. Removing an entry from the manifest does not delete its wiki page.
