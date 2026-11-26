import type { Config } from 'tailwindcss';

// Every colour is a theme token (globals.css): light by default, dark under
// prefers-color-scheme or <html data-theme="dark">. Channels, so `/alpha` works.
const token = (name: string) => `rgb(var(--c-${name}) / <alpha-value>)`;

export default {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        bg: token('bg'),
        panel: token('panel'),
        panel2: token('panel2'),
        border: token('border'),
        muted: token('muted'),
        text: token('text'),
        accent: token('accent'),
        'on-accent': token('on-accent'),
        primary: token('primary'),
        'on-primary': token('on-primary'),
        bronze: token('bronze'),
        sand: token('sand'),
        success: token('success'),
        danger: token('danger'),
        warn: token('warn'),
        scrim: token('scrim'),
      },
      fontFamily: {
        sans: ['var(--font-text)'],
        display: ['var(--font-display)'],
        mono: ['var(--font-mono)'],
      },
      fontSize: {
        // Compact scale: body 13px, labels 12px; meta `.text-2xs` (12px, globals.css) never goes smaller.
        xs: ['12px', '16px'],
        sm: ['13px', '20px'],
      },
      borderRadius: {
        // One radius family ("soft"): controls 8, panels 12, frames 20.
        md: '8px',
        lg: '8px',
        xl: '12px',
        '2xl': '20px',
      },
      transitionTimingFunction: {
        ui: 'cubic-bezier(.2,.8,.2,1)',
      },
    },
  },
  plugins: [],
} satisfies Config;
