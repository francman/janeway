import type { Config } from 'tailwindcss'
import { fontSize } from '@janeway/ui/tokens'

export default {
  content: ['./src/**/*.{ts,tsx}', '../../packages/ui/src/**/*.{ts,tsx}'],
  darkMode: 'class',
  theme: { fontSize },
  plugins: [],
} satisfies Config
