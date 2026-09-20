/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        ink: {
          950: '#070a15',
          900: '#0b1020',
          850: '#0f1630',
          800: '#141c3a',
          700: '#1c2749',
          600: '#2a3866',
        },
        brand: {
          50: '#eef4ff',
          300: '#8fb4ff',
          400: '#5c8dff',
          500: '#3b6dfb',
          600: '#2b52d6',
        },
        cyan: { 400: '#35d6f0', 500: '#12bcd8' },
        mint: { 400: '#3ddc97', 500: '#22b578' },
        amber: { 400: '#ffc44d', 500: '#f0a020' },
        rose: { 400: '#ff7089', 500: '#e8455f' },
        violet: { 400: '#a78bfa', 500: '#8b5cf6' },
      },
      fontFamily: {
        sans: ['"PingFang SC"', '"Microsoft YaHei"', 'Inter', 'system-ui', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      boxShadow: {
        card: '0 1px 0 0 rgba(255,255,255,0.04) inset, 0 12px 32px -18px rgba(0,0,0,0.9)',
        glow: '0 0 0 1px rgba(59,109,251,0.35), 0 10px 30px -12px rgba(59,109,251,0.45)',
      },
      keyframes: {
        'fade-up': { '0%': { opacity: '0', transform: 'translateY(6px)' }, '100%': { opacity: '1', transform: 'translateY(0)' } },
      },
      animation: { 'fade-up': 'fade-up .28s ease-out both' },
    },
  },
  plugins: [],
}
