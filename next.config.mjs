/** @type {import('next').NextConfig} */
const cdnHost = (() => {
  try {
    return process.env.ARTICLES_IMAGE_CDN_URL
      ? new URL(process.env.ARTICLES_IMAGE_CDN_URL).hostname
      : null
  } catch {
    return null
  }
})()

// Amplify Hosting Compute (Next.js SSR Lambda) doesn't propagate app-level env
// vars to the Lambda runtime. Vars declared here are inlined as literals at
// build time, which is the documented way to make them available server-side.
const inlinedEnv = Object.fromEntries(
  Object.entries({
    ARTICLES_BUCKET: process.env.ARTICLES_BUCKET,
    ARTICLES_TABLE: process.env.ARTICLES_TABLE,
    ARTICLES_IMAGE_CDN_URL: process.env.ARTICLES_IMAGE_CDN_URL,
    SITE_URL: process.env.SITE_URL,
    REVALIDATE_SECRET: process.env.REVALIDATE_SECRET,
  }).filter(([, v]) => v !== undefined),
)

const nextConfig = {
  pageExtensions: ['js', 'jsx', 'ts', 'tsx'],
  env: inlinedEnv,
  images: {
    remotePatterns: cdnHost
      ? [{ protocol: 'https', hostname: cdnHost }]
      : [],
  },
}

export default nextConfig
