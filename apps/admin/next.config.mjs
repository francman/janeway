/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'export',
  trailingSlash: true,
  poweredByHeader: false,
  reactStrictMode: true,
  devIndicators: { buildActivity: false, appIsrStatus: false },
  transpilePackages: ['@janeway/ui'],
  images: { unoptimized: true },
}

export default nextConfig
