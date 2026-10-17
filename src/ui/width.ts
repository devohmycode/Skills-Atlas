import stringWidth from 'string-width';

/**
 * Terminal columns taken by a string: Chinese, Japanese and Korean characters (and most emoji)
 * take two, so `.length` and `padEnd` misalign any column holding them.
 */
export const width = (text: string): number => stringWidth(text);

export function padEnd(text: string, columns: number): string {
  return text + ' '.repeat(Math.max(0, columns - width(text)));
}

export function padStart(text: string, columns: number): string {
  return ' '.repeat(Math.max(0, columns - width(text))) + text;
}

/** Exactly `columns` wide: padded, or cut with an ellipsis (never splitting a wide character). */
export function fit(text: string, columns: number): string {
  if (columns <= 0) return '';
  if (width(text) <= columns) return padEnd(text, columns);
  let out = '';
  let used = 0;
  for (const char of text) {
    const w = width(char);
    if (used + w > columns - 1) break;
    out += char;
    used += w;
  }
  return `${out}…${' '.repeat(columns - 1 - used)}`;
}

/**
 * Lines of at most `columns` terminal columns: each source line wrapped at its
 * last space that fits, or cut when a word is longer than a line. Never splits a wide character.
 */
export function wrapLines(text: string, columns: number): string[] {
  const out: string[] = [];
  for (const line of text.split('\n')) {
    let current = '';
    for (const char of line) {
      if (current && width(current + char) > columns) {
        const space = current.lastIndexOf(' ');
        if (space > 0) {
          out.push(current.slice(0, space));
          current = current.slice(space + 1);
        } else {
          out.push(current);
          current = '';
        }
      }
      current += char;
    }
    out.push(current);
  }
  return out;
}
