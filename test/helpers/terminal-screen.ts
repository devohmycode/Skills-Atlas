import stringWidth from 'string-width';

/** Replay the terminal output (including cursor moves), rather than treating frames as text. */
export class TerminalScreen {
  private grid: string[][];
  private x = 0;
  private y = 0;
  private pending = '';
  private wrap = false;

  constructor(private columns: number, private rows: number) {
    this.grid = Array.from({ length: rows }, () => this.blank());
  }

  private blank() { return Array<string>(this.columns).fill(' '); }
  private nextLine() {
    this.x = 0;
    this.wrap = false;
    if (++this.y >= this.rows) { this.grid.shift(); this.grid.push(this.blank()); this.y = this.rows - 1; }
  }

  write(chunk: string) {
    this.pending += chunk;
    while (this.pending) {
      if (this.pending.startsWith('\u001b[')) {
        const match = /^\u001b\[([?\d;]*)([@-~])/.exec(this.pending);
        if (!match) return;
        this.pending = this.pending.slice(match[0].length);
        if (match[1]!.startsWith('?') || match[2] === 'm') continue;
        const params = match[1]!.split(';').map(Number);
        const n = params[0] || 1;
        this.wrap = false;
        switch (match[2]) {
          case 'A': this.y = Math.max(0, this.y - n); break;
          case 'B': this.y = Math.min(this.rows - 1, this.y + n); break;
          case 'C': this.x = Math.min(this.columns - 1, this.x + n); break;
          case 'D': this.x = Math.max(0, this.x - n); break;
          case 'E': this.y = Math.min(this.rows - 1, this.y + n); this.x = 0; break;
          case 'F': this.y = Math.max(0, this.y - n); this.x = 0; break;
          case 'G': this.x = Math.min(this.columns - 1, n - 1); break;
          case 'H': case 'f': this.y = Math.min(this.rows - 1, n - 1); this.x = Math.min(this.columns - 1, (params[1] || 1) - 1); break;
          case 'K': {
            const mode = params[0] || 0;
            this.grid[this.y]!.fill(' ', mode === 0 ? this.x : 0, mode === 1 ? this.x + 1 : this.columns);
            break;
          }
          case 'J': if (params[0] === 2) this.grid = Array.from({ length: this.rows }, () => this.blank()); break;
        }
        continue;
      }
      if (this.pending.startsWith('\u001b]')) {
        const end = /\u0007|\u001b\\/.exec(this.pending);
        if (!end) return;
        this.pending = this.pending.slice(end.index + end[0].length);
        continue;
      }
      const char = String.fromCodePoint(this.pending.codePointAt(0)!);
      this.pending = this.pending.slice(char.length);
      if (char === '\n') { this.nextLine(); continue; }
      if (char === '\r') { this.x = 0; this.wrap = false; continue; }
      if (char < ' ') continue;
      const width = stringWidth(char);
      if (!width) continue;
      if (this.wrap || this.x + width > this.columns) this.nextLine();
      this.grid[this.y]![this.x] = char;
      if (width === 2) this.grid[this.y]![this.x + 1] = '';
      this.x += width;
      if (this.x >= this.columns) { this.x = this.columns - 1; this.wrap = true; }
    }
  }

  get text() { return this.grid.map((line) => line.join('').trimEnd()).join('\n'); }
}
