#!/usr/bin/env bash
# Checks the shell completion scripts: syntax, then a real completion in each shell.
# Needs skills-atlas on PATH (npm run build && npm link) and bash, zsh, fish, pwsh.
# Usage: scripts/check-completion.sh [shell...]   (default: all four)
set -u
dir=$(mktemp -d)
failed=0
pass() { echo "ok   $1"; }
fail() { echo "FAIL $1"; failed=1; }
# `skills-atlas ins` must offer `install`.
expect_install() { grep -qx 'install' && pass "$1" || fail "$1"; }

for shell in "${@:-bash zsh fish powershell}"; do
  for sh in $shell; do
    file="$dir/completion.$sh"
    skills-atlas completion "$sh" > "$file" || { fail "$sh: script not generated"; continue; }
    case "$sh" in
      bash)
        bash -n "$file" && pass "bash: syntax" || fail "bash: syntax"
        bash -c "source '$file'; COMP_LINE='skills-atlas ins'; COMP_POINT=\${#COMP_LINE}; _skills_atlas; printf '%s\n' \"\${COMPREPLY[@]}\"" \
          | expect_install "bash: completes 'skills-atlas ins'"
        ;;
      zsh)
        zsh -n "$file" && pass "zsh: syntax" || fail "zsh: syntax"
        # compdef and compadd belong to the completion system: stand-ins print what would be offered.
        zsh -c "compdef() { :; }; compadd() { [[ \$1 == -- ]] && shift; print -l -- \"\$@\"; }; source '$file'; words=(skills-atlas ins); CURRENT=2; _skills_atlas" \
          | expect_install "zsh: completes 'skills-atlas ins'"
        ;;
      fish)
        fish -n "$file" && pass "fish: syntax" || fail "fish: syntax"
        fish -c "source '$file'; complete -C 'skills-atlas ins'" | cut -f1 \
          | expect_install "fish: completes 'skills-atlas ins'"
        ;;
      powershell)
        pwsh -NoProfile -Command "\$e = \$null; [void][System.Management.Automation.Language.Parser]::ParseFile('$file', [ref]\$null, [ref]\$e); if (\$e.Count) { \$e; exit 1 }" \
          && pass "powershell: syntax" || fail "powershell: syntax"
        pwsh -NoProfile -Command ". '$file'; (TabExpansion2 -inputScript 'skills-atlas ins' -cursorColumn 16).CompletionMatches | ForEach-Object CompletionText" \
          | tr -d '\r' | expect_install "powershell: completes 'skills-atlas ins'"
        ;;
      *) fail "$sh: unknown shell" ;;
    esac
  done
done
rm -rf "$dir"
exit $failed
