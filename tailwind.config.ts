import typographyPlugin from '@tailwindcss/typography'
import { type Config } from 'tailwindcss'

import typographyStyles from './typography'
import { fontSize } from '@janeway/ui/tokens'

export default {
  content: ['./src/**/*.{js,jsx,ts,tsx}', './packages/ui/src/**/*.{js,jsx,ts,tsx}'],
  darkMode: 'class',
  plugins: [typographyPlugin],
  theme: {
    fontSize,
    typography: typographyStyles,
  },
} satisfies Config
