/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: ['selector', '[data-theme="dark"]'],
  content: [
    "./src/pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        brand: {
          50: "#f0f9ff",
          100: "#e0f2fe",
          200: "#bae6fd",
          300: "#7dd3fc",
          400: "#38bdf8",
          500: "#0ea5e9",
          600: "#0284c7",
          700: "#0369a1",
          800: "#075985",
          900: "#0c4a6e",
        },
        surface: {
          0: "var(--color-surface-0)",
          1: "var(--color-surface-1)",
          2: "var(--color-surface-2)",
          3: "var(--color-surface-3)",
          4: "var(--color-surface-4)",
        },
        "accent-fg": "var(--accent-fg)",
        "accent-subtle": "var(--accent-subtle)",
        "info-fg": "var(--info-fg)",
        "info-subtle": "var(--info-subtle)",
        "success-fg": "var(--success-fg)",
        "success-subtle": "var(--success-subtle)",
        "warning-fg": "var(--warning-fg)",
        "warning-subtle": "var(--warning-subtle)",
        "danger-fg": "var(--danger-fg)",
        "danger-subtle": "var(--danger-subtle)",
        "violet-fg": "var(--violet-fg)",
        "violet-subtle": "var(--violet-subtle)",
      },
      textColor: {
        primary: "var(--color-text-primary)",
        secondary: "var(--color-text-secondary)",
        muted: "var(--color-text-muted)",
      },
      borderColor: {
        theme: "var(--color-border)",
      },
      placeholderColor: {
        muted: "var(--color-text-muted)",
      },
    },
  },
  plugins: [require("@tailwindcss/typography")],
};
