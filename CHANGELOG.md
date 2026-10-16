# Changelog

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
