/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        bg: "#121316",
        surface: "#18191E",
        text: "#E6E7EB",
        muted: "#8B8F9A",
        accent: "#7C5CFF",
        cyan: "#35D0FF",
        stem: {
          drums: "#FF6B6B",
          bass: "#FFB84D",
          mid: "#7C5CFF",
          highs: "#35D0FF",
        },
      },
      borderRadius: {
        "2xl": "1rem",
      },
      boxShadow: {
        "neu-raised": "8px 8px 18px #0B0C0E, -6px -6px 14px #22242B",
        "neu-inset": "inset 6px 6px 12px #0B0C0E, inset -4px -4px 10px #22242B",
        "neu-pressed": "inset 4px 4px 10px #0B0C0E, inset -3px -3px 8px #22242B",
      },
    },
  },
  plugins: [],
};
