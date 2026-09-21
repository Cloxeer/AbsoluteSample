/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        bg: "#111214",
        surface: "#1A1B1F",
        "surface-2": "#212327",
        line: "rgba(255,255,255,.06)",
        text: "#ECEDEF",
        muted: "#9A9EA8",
        accent: "#F2B33D",
        "accent-ink": "#1A1300",
        danger: "#E5484D",
        ok: "#3DD68C",
        cyan: "#4CC9F0",
        stem: {
          drums: "#F2B33D",
          bass: "#4C8BF5",
          mid: "#F25F5C",
          highs: "#8A94A6",
        },
        instrument: {
          vocals: "#F25F5C",
          drums: "#F2B33D",
          bass: "#4C8BF5",
          guitar: "#3DD68C",
          keys: "#B692F6",
          other: "#8A94A6",
        },
      },
      fontFamily: {
        ui: ["Manrope", "-apple-system", "BlinkMacSystemFont", "Segoe UI", "Roboto", "Helvetica", "Arial", "sans-serif"],
        mono: ["JetBrains Mono", "ui-monospace", "SFMono-Regular", "Menlo", "Consolas", "monospace"],
      },
      borderRadius: {
        "2xl": "1rem",
      },
      boxShadow: {
        "neu-raised": "4px 4px 10px rgba(0,0,0,0.28), -3px -3px 8px rgba(255,255,255,0.03)",
        "neu-inset": "inset 3px 3px 7px rgba(0,0,0,0.3), inset -2px -2px 5px rgba(255,255,255,0.03)",
        "neu-pressed": "inset 2px 2px 5px rgba(0,0,0,0.32), inset -1px -1px 4px rgba(255,255,255,0.03)",
      },
    },
  },
  plugins: [],
};
