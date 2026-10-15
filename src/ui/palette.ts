/** Shared terminal and web colors. */
export const PALETTE = {
  background: '#0E0D0B',
  foreground: '#EAE5D9',
  muted: '#A59D91',
  accent: '#8BD5F5',
  lavender: '#B69BFA',
  pink: '#F09DDB',
  gold: '#E6BF68',
  success: '#A6D5B2',
  danger: '#F29A91',
  border: '#3A352F',
} as const;

/** Candy pink replaces success green throughout the CLI and terminal wizard. */
export const TERMINAL_PALETTE = { ...PALETTE, success: '#FF8AD8' } as const;

export const LOGO_STOPS: [number, number, number][] = [
  [139, 213, 245],
  [182, 155, 250],
  [240, 157, 219],
];
