# Changelog

## Unreleased

## 0.30.0 — 2026-10-23

- **Update checks say when they are incomplete.** A repository GitHub does not answer for (HTTP 403 rate limit, timeout, invalid answer), a truncated tree or a skill folder it no longer has is reported instead of read as up to date: the tree shows a warning, `outdated` and `update` name each on stderr and exit with 1, and `update` still runs the updates it confirmed. `outdated --json` keeps its array on stdout. A skill installed at the repository root is now checked too.
- **MCP `outdated_skills` returns `{ skills, unchecked }`** instead of an array: the skills as before, with their diff, and the repositories that could not be checked. Agents reading the old array must read `skills`.
- **Rollback records only a proven version.** The commit kept before an update must have the lock's folder hash: a commit found by date alone is checked against GitHub, and after `rollback` the exact commit is remembered (`revisions.json`, next to `history.json`) while the lock keeps that hash. A rollback to an old commit followed by an update now goes back to that commit, not to the latest one on the branch. When no version can be proven, `update` says the skill has no way back.
- **Skill names are checked wherever an id is read.** `install o/r@--global` and every other entry point (selection files, packs, MCP, the web page, removals) refuse a name that is empty, starts with `-`, holds a quote or a control character, or is longer than 200 characters, before any command is built.
- **MCP installs and removals run one at a time**, each re-checking what is installed, so two calls cannot write the lock together or miss each other's name collisions. Reads and dry runs do not wait.
- **Catalogs are checked when they load.** A snapshot with missing or mistyped fields is rejected with the field's path; a bad download never replaces a valid cache. Entries `install` would refuse (59 in the current snapshot, such as names starting with `-`) are left out. Older snapshots and unknown fields still load.
- **An empty crawl fails** instead of replacing the snapshot with zero skills.
- **Web page:** a failed "Show more" keeps the rows already loaded and shows the error under them; the next try loads from the same place. After a change in the side panel, the focus stays on the same agent, scope or method control (or the panel's first control when it went away).
- **CI:** types, tests and build run on every pull request.

Validation: 268 tests and TypeScript checks.

## 0.20.0 — 2026-10-21

- **The audit reads the whole skill folder.** Besides the `SKILL.md`, the skill's other text files (scripts, references, configs) are checked: a clean `SKILL.md` that runs a `curl | sh` script now fails. Findings name their file (`scripts/setup.sh:12`) on the review screen, with `install -y`, `show`, the web page and MCP. Binaries, large files and unreadable ones are reported as not audited.
- **See what an update changes.** In the tree, `p` on a skill marked for update shows the diff between the installed `SKILL.md` and the new one, with only the warning signs the new version adds. `skills-atlas update` (and `--dry-run`) prints the changed line counts and those warning signs first; MCP's `outdated_skills` returns them.
- **Roll back an update.** Each update first records the commit the skill was installed from. `skills-atlas rollback <id>` reinstalls it for the skill's own agents, audited at that revision; `--list` shows the recorded versions (five per skill) and `--to <sha>` picks one.
- **Prerequisites in the catalog.** Each crawl reads the `SKILL.md` of the 3,000 most installed skills for the programs they need and their `compatibility` text, and dates the folder's last change for the top 1,000 (about 3 KB more in the snapshot). The tree's details show them, missing programs in red; the web page shows them as tags; MCP returns `requires` and `updated_at`. `--ready` (browse, list) keeps only the skills whose programs are all installed.
- **Trending without clone networks.** Repositories that grow the same skills as at least two others (three shared names, 1,000+ installs each) stay out of Trending; in the current snapshot, six copies of one bundle held nearly half of the theme. Their details say why.
- **Repository health.** The crawl records each repository's license, archive state and last push (GitHub GraphQL, 5,000 repositories). Skills of archived or year-old repositories sort after the others, `--active` leaves them out, and the tree, the web page and MCP show license and state.
- The web demo link pointed to `devohmycode.github.io/skills-atlas`, which answers 404 since the repository became `Skills-Atlas` (GitHub Pages paths are case-sensitive). Links, package metadata, the plugin manifest and the catalog URL now use the repository's own name.
- **Prerequisites.** The risk check reads what a `SKILL.md` frontmatter says it needs. Programs under `requires.bins` that are not on your `PATH` are a medium warning, named on the review screen and by `install -y` before any command runs. The `compatibility` field is shown as information in `p`, `show` and MCP's `show_skill`.

Validation: 249 tests and TypeScript checks.

## 0.12.0 — 2026-10-18

- **Pinned project skills.** `skills-atlas.json` takes optional `revisions`, a full commit SHA per skill. `skills-atlas lock` writes them, and `lock --dry-run` shows the old and new commits with compare links. `sync` then installs and audits that exact revision and checks every installed copy byte for byte against it. `sync --check` also reports drifted content.
- **`sync` checks every target agent.** A skill installed for Cursor alone no longer satisfies a request for Claude Code. Only the missing skill/agent combinations are installed. `-a` overrides the file's agents, and `-a '*'` means every supported agent.
- **`skills-atlas doctor`** diagnoses installed skills without changing anything: dangling links, unreadable folders or `SKILL.md`, a malformed lock file, and lock entries whose skill is gone. Use `-p` or `-g` for one scope, and `--json` for scripts. It exits with 1 when it finds issues.
- **Better search.** Search ignores case and accents and checks names, descriptions and labels. Every word must match. Name matches rank first, and installs break ties. This applies to the CLI, the tree, the web page, the demo and MCP.
- **Web page: details and audit.** **Details** (or `p`) shows a skill's `SKILL.md`, its warning signs and any replacements. The changes panel runs the security audit. A skill that fails it is blocked until you tick **install anyway** for that skill, and Apply audits again before running.
- **Web page: retry what failed.** After a partial failure or a lost connection, the page keeps only what is still outstanding. **Retry remaining changes** installs only for the agents that still lack the skill.
- **Web page: save as pack.** The checked catalog skills become a personal pack in `packs.json`. It is available right away, and existing packs are never overwritten.
- **Catalog health.** A snapshot records each source's status. The tree and the web page warn when a source was unavailable during the crawl. Packs show how many of their members are in the catalog and which are missing, in `skills-atlas packs` too.

Validation: 229 tests and TypeScript checks.

## 0.11.0 — 2026-10-18

- **Security audit before installing.** The risk check now runs on every skill to install or update. A skill with a high warning sign fails: on the review screen it is listed unticked, with its warning signs, and space installs it anyway; without a person at the keyboard (`install -y`, `import`, `sync`, `update`) it is left out; the MCP server refuses it unless `ignore_audit: true`. `skills-atlas audit on|off` sets it for good, `--no-audit` for one command.
- `install` with questions now installs what its review screen kept, not every id it was given.
- **Update everything.** `skills-atlas update` updates every outdated global skill, or only the ones named, each for its own agents (`--dry-run` available). In the tree, `U` marks every outdated skill at once.

Validation: 161 tests and TypeScript checks.

## 0.10.0 — 2026-10-18

- **📦 Packs.** Curated sets of skills to install together: Frontend dev, Security review, Code quality & testing, Writing & docs. Each is a theme in the tree and on the web page (tick it to take the pack), `skills-atlas packs` lists them and `install --pack <id>` installs one. A personal `packs.json` replaces them.
- **A project's skills.** A `skills-atlas.json` at a repository's root lists the skills it expects, in the `export` format with optional `agents`. `skills-atlas sync` installs the missing ones in the project; `sync --check` lists them and exits with 1, for CI.
- **Per agent.** `skills-atlas installed` lists the installed skills under each agent that sees them; `-a codex claude-code` shows only those, side by side, and `--json` is available. In the tree, an installed skill's details name its agents.
- **Shell completion** for bash, zsh, fish and PowerShell: `skills-atlas completion <shell>` prints the script. It completes commands, options, skill ids, agents, themes and languages, from the cached catalog.
- **Same name, one folder.** The skills CLI installs by name, so a skill from another repository silently replaced an installed one of the same name, or another one selected in the same run. The review screen now lists such replacements, `install` and `import` warn before running, and the MCP server refuses them unless `replace: true`.
- **Risk check.** The `p` preview, `show` and the MCP server's `show_skill` point at what a `SKILL.md` asks for beyond its description: downloading and running code, credential files, broad deletions, instructions to hide things from the user (high); administrator commands, secrets read from the environment, data sent to a server (medium); packages or scripts run (info). A pattern check on the text, tuned on the 150 most installed skills, which it leaves without a false high alert; it points at lines to read, it does not prove a skill safe.
- **🔥 Trending.** Each crawl records the installs every skill gained since the previous snapshot. The 50 that gained the most form a Trending theme, right after Recommended, sorted by growth, with the gain shown in the details.

Validation: 158 tests and TypeScript checks.

## 0.9.2 — 2026-10-17

- **From Claude and other agents.** A `skills-atlas` skill (`npx skills add devohmycode/skills-atlas -s skills-atlas`), an MCP server (`skills-atlas mcp`: search, read, list, check updates, install and remove skills as tools) and a Claude Code plugin bundling both with a `/skills-atlas` command (`/plugin install skills-atlas --marketplace devohmycode/skills-atlas`).
- **`show` and `outdated`.** `skills-atlas show <id>` prints a skill's `SKILL.md`; `skills-atlas outdated` lists the global skills with a newer version; both take `--json`.
- **Skills at the root of their repository.** Their `SKILL.md` path was recorded as the skill's directory (`SKILL.md/SKILL.md`), so `show` and the `p` preview failed with a 404 for about 800 of them. Paths are now read as directories, the root included, and older snapshots are corrected on the fly.

Validation: 138 tests and TypeScript checks.

## 0.9.1 — 2026-10-17

- Published again with everything from 0.9.0: versions 0.6.0 to 0.9.0 were withdrawn from npm.
- The catalog drops the skills their repository no longer holds (412 in this snapshot), and the crawl no longer fails when `main` moves while it runs.

## 0.9.0 — 2026-10-17

- **Preview a skill before installing it.** Press **`p`** on a skill to read its `SKILL.md`, fetched from GitHub, in place of the list; ↑↓, PgUp/PgDn or the wheel scroll it, esc goes back. A skill runs with your agent's permissions, so reading it first is worth it. The text is shown without its escape sequences, so that it cannot drive the terminal.
- **Export and import a selection.** `skills-atlas export > my-skills.json` writes the installed skills; `skills-atlas import my-skills.json` installs them on another machine or in another project, with the same options as `install`. The file is checked first: a malformed id, or a skill name that could pass for a flag, stops the import.
- **New version notice.** A dim line tells when a newer skills-atlas is published, above the tree and under the `ui` address. npm is asked at most once a day, in the background.
- **Web demo.** A read-only copy of the web interface, with the 3,000 most installed skills, rebuilt with each catalog: https://devohmycode.github.io/skills-atlas/demo/ (`npm run demo`).
- **README.** An animated terminal session and npm badges.
- **Internals.** The terminal and the web page share one grouping by repository for Recommended, and the return to the list after a run is tested.

Validation: 134 tests and TypeScript checks.

## 0.8.0 — 2026-10-17

- **Skill updates.** Globally installed skills with a newer version on GitHub read `↑ update available`, and the status line counts them. Press **`u`** to mark the focused skill, or the outdated skills of a group, then continue: each one is reinstalled at its latest version for the agents that already have it. The check compares the folder hash in the skills lock file with GitHub, one request per repository, in the background; it uses `GITHUB_TOKEN`, `GH_TOKEN` or the GitHub CLI's token when there is one. Project skills are not checked, as their lock records a hash GitHub cannot be compared with.
- **Back where you were.** After an install, the tree reopens the same groups and focuses the same row, even when the new installs moved it.
- **Recommended on the web.** A repository whose skills are only partly ticked shows a partial checkbox instead of an empty one.
- **Catalog.** The crawl drops skills that their repository no longer holds, such as renamed or deleted ones still listed by the registries; installing them could only fail. They leave the catalog with the next snapshot.

Validation: 120 tests and TypeScript checks.

## 0.7.2 — 2026-10-16

- **★ Recommended** groups its skills by repository: Ponytail, mattpocock/skills, obra/superpowers and addyosmani/agent-skills. Open a repository to tick the skills you want, or tick the repository to take them all. These are the catalog's own skills, so installed ones are detected and ticked, and each installs on its own.
- After installing or uninstalling, `skills-atlas` returns to the skill list with the run's summary, until you quit.
- Replace the interactive whole-repository install of 0.7.1.

Validation: 113 tests and TypeScript checks.

## 0.7.1 — 2026-10-16

- **★ Recommended** now lists four whole repositories: [Ponytail](https://github.com/DietrichGebert/ponytail), [mattpocock/skills](https://github.com/mattpocock/skills), [obra/superpowers](https://github.com/obra/superpowers) and [addyosmani/agent-skills](https://github.com/addyosmani/agent-skills).
- A recommendation without `name` stands for its whole repository. Installing it runs `npx skills add <repository>` in the terminal, without `-s`, so the skills CLI asks which of its skills to install. The web interface shows that command to run from a terminal instead.

Validation: 114 tests and TypeScript checks.

## 0.7.0 — 2026-10-15

- Add **★ Recommended** below installed skills in the terminal and web interface, starting with Ponytail. Maintain the shared selection in `data/recommended.json`, or replace it with a personal JSON file in the user configuration directory.
- Press **`g`** on a focused skill to open its GitHub repository.
- Add Italian and translate the new interface labels in all nine languages. Keep support for locale forms including `it-IT` and `zh-CN`.
- Apply a blue–lavender–pink palette, with candy-pink terminal selections and gold recommendation stars.
- Improve list navigation with cached views, reliable rapid keyboard input, production React and a 60 FPS limit. Update web selections and pagination without rebuilding every loaded row.
- Keep Ink's stable terminal renderer to prevent duplicate lines, with screen replay regression tests for multiple terminal sizes.

Validation: 112 tests, TypeScript checks, production build and package-content verification.
