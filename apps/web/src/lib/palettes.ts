/** The five reviewed palettes (values generated from the review script). */
export type PaletteKey = 'amber' | 'harbour' | 'sage' | 'slate' | 'terracotta';
export const PALETTES: { key: PaletteKey; name: string; light: string[]; dark: string[] }[] = [
  { key: 'amber', name: 'A 琥珀', light: ['#f4f4f2', '#fdfdfc', '#24221e', '#a8620c'], dark: ['#1d1c1a', '#262522', '#ebe8e2', '#e9bd78'] },
  { key: 'harbour', name: 'B 港湾蓝', light: ['#f3f4f6', '#fcfcfd', '#20262e', '#2c5877'], dark: ['#171b21', '#1f242c', '#e4e8ee', '#8fbfe3'] },
  { key: 'sage', name: 'C 鼠尾草', light: ['#f2f3f0', '#fcfcfb', '#22261f', '#2e5b44'], dark: ['#181c1a', '#202523', '#e3e4dd', '#a6cdb9'] },
  { key: 'slate', name: 'D 石板青', light: ['#f3f6f7', '#fcfdfd', '#1e2a2f', '#0d7480'], dark: ['#161b1d', '#1e2427', '#e2eaed', '#7fc8cf'] },
  { key: 'terracotta', name: 'E 陶土', light: ['#f6f3ee', '#fefdfb', '#2b241e', '#a3472b'], dark: ['#1e1b18', '#27231f', '#ece6de', '#eea98e'] },
];
