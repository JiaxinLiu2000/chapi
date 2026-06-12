import type { Config } from 'tailwindcss';

export default {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        bg: '#0f1115',
        panel: '#171a21',
        panel2: '#1e222b',
        border: '#2a2f3a',
        muted: '#8b93a7',
        text: '#e6e9ef',
        accent: '#6d8bff',
        success: '#3fb950',
        danger: '#f85149',
        warn: '#d29922',
      },
      fontFamily: {
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
    },
  },
  plugins: [],
} satisfies Config;
