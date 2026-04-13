/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        "quotefly-primary": "#5B85AA",
        "quotefly-secondary": "#F46036",
        "quotefly-accent": "#414770",
        "quotefly-deep": "#372248",
        "quotefly-ink": "#171123",
        "quotefly-blue": "#5B85AA",
        "quotefly-orange": "#F46036",
        "quotefly-gold": "#414770",
        "quotefly-success": "#059669",
        "quotefly-warning": "#d97706",
      },
      fontFamily: {
        "sans": ["Plus Jakarta Sans", "sans-serif"],
        "display": ["Sora", "Plus Jakarta Sans", "sans-serif"],
      },
    },
  },
  plugins: [],
};
