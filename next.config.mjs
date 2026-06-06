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

const nextConfig = {
  pageExtensions: ['js', 'jsx', 'ts', 'tsx'],
  images: {
    remotePatterns: cdnHost
      ? [{ protocol: 'https', hostname: cdnHost }]
      : [],
  },
}

export default nextConfig
