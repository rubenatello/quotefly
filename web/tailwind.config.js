/** @type {import('tailwindcss').Config} */
export default {
  darkMode: "class",
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        "quotefly-primary": "#2F6FD6",
        "quotefly-secondary": "#F28C28",
        "quotefly-accent": "#4C5FA8",
        "quotefly-deep": "#1F2F55",
        "quotefly-ink": "#101828",
        "quotefly-blue": "#2F6FD6",
        "quotefly-orange": "#F28C28",
        "quotefly-gold": "#4C5FA8",
        "quotefly-success": "#059669",
        "quotefly-warning": "#d97706",
        "qf-canvas": "rgb(var(--qf-canvas-rgb) / <alpha-value>)",
        "qf-surface": "rgb(var(--qf-panel-rgb) / <alpha-value>)",
        "qf-surface-muted": "rgb(var(--qf-panel-muted-rgb) / <alpha-value>)",
        "qf-surface-subtle": "rgb(var(--qf-panel-subtle-rgb) / <alpha-value>)",
        "qf-border": "rgb(var(--qf-border-rgb) / <alpha-value>)",
        "qf-text": "rgb(var(--qf-text-rgb) / <alpha-value>)",
        "qf-text-soft": "rgb(var(--qf-text-soft-rgb) / <alpha-value>)",
        "qf-text-muted": "rgb(var(--qf-text-muted-rgb) / <alpha-value>)",
      },
      fontFamily: {
        "sans": ["DM Sans", "sans-serif"],
        "display": ["Outfit", "DM Sans", "sans-serif"],
      },
      boxShadow: {
        "qf-sm": "0 1px 2px rgba(15, 23, 42, 0.05)",
        "qf-md": "0 12px 28px rgba(15, 23, 42, 0.08)",
        "qf-mobile": "0 16px 40px rgba(15, 23, 42, 0.16)",
      },
    },
  },
  plugins: [],
};
