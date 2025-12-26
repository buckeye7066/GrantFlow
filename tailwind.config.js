/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        'axiom-blue': '#1e40af',
        'axiom-light-blue': '#3b82f6',
      },
    },
  },
  plugins: [],
}
