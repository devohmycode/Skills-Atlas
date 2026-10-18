/**
 * Shell completion. The scripts only pass the words typed so far to
 * `skills-atlas __complete -- <words>`; what to offer is decided here, the
 * same way for every shell.
 */

export interface CompletionContext {
  /** Commands with their options (`-a`, `--agent`…). */
  commands: { name: string; options: string[] }[];
  /** Options every command takes (`-l`, `--lang`). */
  globalOptions: string[];
  agents: string[];
  langs: string[];
  themes: () => string[];
  /** Skill ids starting with a prefix, most installed first. */
  ids: (prefix: string) => string[];
}

/** Tells the shell to complete file names itself. */
export const FILES = '__files__';
const SHELLS = ['bash', 'zsh', 'fish', 'powershell'];
const VALUES: Record<string, 'agents' | 'themes' | 'langs'> = { '-a': 'agents', '--agent': 'agents', '-t': 'themes', '--theme': 'themes', '-l': 'langs', '--lang': 'langs' };

/**
 * What to offer for the last word of `words` (the command line after the
 * program's name; the last word is the one being typed, possibly empty).
 */
export function complete(words: string[], ctx: CompletionContext): string[] {
  const cur = words.at(-1) ?? '';
  const before = words.slice(0, -1);
  const starts = (list: string[]) => list.filter((x) => x.toLowerCase().startsWith(cur.toLowerCase()));
  // The command is the first word that is neither an option nor the value of -l.
  const command = before.find((w, i) => !w.startsWith('-') && before[i - 1] !== '-l' && before[i - 1] !== '--lang');
  // -a and -t take several values: still theirs until another option comes.
  const lastOption = [...before].reverse().find((w) => w.startsWith('-'));
  const valuesOf = lastOption && VALUES[lastOption];
  const takesOne = lastOption === '-l' || lastOption === '--lang';
  if (valuesOf && !cur.startsWith('-') && (!takesOne || before.at(-1) === lastOption)) {
    return starts(valuesOf === 'agents' ? ctx.agents : valuesOf === 'langs' ? ctx.langs : ctx.themes());
  }
  if (cur.startsWith('-')) {
    const own = ctx.commands.find((c) => c.name === command)?.options ?? [];
    return starts([...own, ...ctx.globalOptions]);
  }
  if (!command) return starts(ctx.commands.map((c) => c.name));
  if (command === 'install' || command === 'show') return ctx.ids(cur);
  if (command === 'import') return [FILES];
  if (command === 'lang') return starts(ctx.langs);
  if (command === 'completion') return starts(SHELLS);
  return [];
}

/** The script to load in a shell's startup file. */
export function completionScript(shell: string): string | undefined {
  switch (shell) {
    case 'bash':
      return `# skills-atlas completion — add to ~/.bashrc: eval "$(skills-atlas completion bash)"
_skills_atlas() {
  local IFS=$'\\n' line="\${COMP_LINE:0:COMP_POINT}" words cur out pre
  # Split the line ourselves: COMP_WORDS also breaks at @ and :, which skill ids hold.
  IFS=' ' read -ra words <<< "$line"
  [[ "$line" == *' ' ]] && words+=('')
  cur="\${words[\${#words[@]}-1]}"
  out=$("\${words[0]}" __complete -- "\${words[@]:1}" 2>/dev/null)
  if [[ "$out" == ${FILES} ]]; then COMPREPLY=($(compgen -f -- "$cur")); return; fi
  # bash replaces only what follows the last @ or : of the word: drop that part from each candidate.
  pre="\${cur%"\${cur##*[@:]}"}"
  COMPREPLY=($(printf '%s\\n' "$out" | sed "s|^$pre||"))
}
complete -F _skills_atlas skills-atlas
`;
    case 'zsh':
      return `# skills-atlas completion — add to ~/.zshrc: eval "$(skills-atlas completion zsh)"
_skills_atlas() {
  local -a cands
  cands=("\${(@f)$(\${words[1]} __complete -- "\${(@)words[2,CURRENT]}" 2>/dev/null)}")
  if [[ "\${cands[1]}" == ${FILES} ]]; then _files; else compadd -- "\${cands[@]}"; fi
}
compdef _skills_atlas skills-atlas
`;
    case 'fish':
      return `# skills-atlas completion — add to ~/.config/fish/config.fish: skills-atlas completion fish | source
function __skills_atlas_complete
  set -l tokens (commandline -opc) (commandline -ct)
  set -l out ($tokens[1] __complete -- $tokens[2..-1] 2>/dev/null)
  if test "$out[1]" = ${FILES}
    __fish_complete_path (commandline -ct)
  else
    printf '%s\\n' $out
  end
end
complete -c skills-atlas -f -a '(__skills_atlas_complete)'
`;
    case 'powershell':
      return `# skills-atlas completion — add to $PROFILE: skills-atlas completion powershell | Out-String | Invoke-Expression
Register-ArgumentCompleter -Native -CommandName skills-atlas -ScriptBlock {
  param($wordToComplete, $commandAst, $cursorPosition)
  $words = @($commandAst.CommandElements | Select-Object -Skip 1 | ForEach-Object { $_.ToString() })
  if ($wordToComplete -eq '') { $words += '' }
  $out = @(& skills-atlas __complete -- @words 2>$null)
  # No candidate, or file names wanted: PowerShell falls back to paths.
  if ($out.Count -eq 0 -or $out[0] -eq '${FILES}') { return }
  $out | ForEach-Object { [System.Management.Automation.CompletionResult]::new($_, $_, 'ParameterValue', $_) }
}
`;
    default:
      return undefined;
  }
}
