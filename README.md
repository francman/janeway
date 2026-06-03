# Frank Manu

Personal website for Frank Manu, built with Next.js, MDX, Tailwind CSS, and the
Tailwind UI Spotlight template.

## Setup

Install dependencies:

```bash
npm install
```

Create a local environment file from the example:

```bash
cp .env.example .env.local
```

PostHog analytics is optional. Leave `NEXT_PUBLIC_POSTHOG_KEY` blank to run the
site without analytics.

## Scripts

Run the development server:

```bash
npm run dev
```

Build for production:

```bash
npm run build
```

Run lint checks:

```bash
npm run lint
```

## Content

Most site content lives under `src/app`:

- `src/app/page.tsx`: homepage, work history, education, and recent writings.
- `src/app/about/page.tsx`: about page.
- `src/app/projects/page.tsx`: project cards.
- `src/app/readings/page.tsx`: books, audiobooks, papers, movies, and shows.
- `src/app/lab233/page.tsx`: tools and home lab notes.
- `src/app/writings/*/page.mdx`: MDX articles.

Static images and logos live under `src/images`.

## Environment Variables

```env
NEXT_PUBLIC_POSTHOG_KEY=
NEXT_PUBLIC_POSTHOG_HOST=https://us.i.posthog.com
```

These values are public browser environment variables. Do not put private
server-side secrets in variables prefixed with `NEXT_PUBLIC_`.

## Notes

The app is static-first and currently has no backend. Keep third-party account
credentials out of the deployed app; use local scripts or data exports for
content automation.
