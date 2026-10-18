# Changelog

## Unreleased

- **📦 Packs.** Curated sets of skills to install together: Frontend dev, Security review, Code quality & testing, Writing & docs. Each is a theme in the tree and on the web page (tick it to take the pack), `skills-atlas packs` lists them and `install --pack <id>` installs one. A personal `packs.json` replaces them.
- **A project's skills.** A `skills-atlas.json` at a repository's root lists the skills it expects, in the `export` format with optional `agents`. `skills-atlas sync` installs the missing ones in the project; `sync --check` lists them and exits with 1, for CI.
- **Per agent.** `skills-atlas installed` lists the installed skills under each agent that sees them; `-a codex claude-code` shows only those, side by side, and `--json` is available. In the tree, an installed skill's details name its agents.
- **Shell completion** for bash, zsh, fish and PowerShell: `skills-atlas completion <shell>` prints the script. It completes commands, options, skill ids, agents, themes and languages, from the cached catalog.
- **Same name, one folder.** The skills CLI installs by name, so a skill from another repository silently replaced an installed one of the same name, or another one selected in the same run. The review screen now lists such replacements, `install` and `import` warn before running, and the MCP server refuses them unless `replace: true`.
- **Risk check.** The `p` preview, `show` and the MCP server's `show_skill` point at what a `SKILL.md` asks for beyond its description: downloading and running code, credential files, broad deletions, instructions to hide things from the user (high); administrator commands, secrets read from the environment, data sent to a server (medium); packages or scripts run (info). A pattern check on the text, tuned on the 150 most installed skills, which it leaves without a false high alert; it points at lines to read, it does not prove a skill safe.
- **🔥 Trending.** Each crawl records the installs every skill gained since the previous snapshot. The 50 that gained the most form a Trending theme, right after Recommended, sorted by growth, with the gain shown in the details.

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
