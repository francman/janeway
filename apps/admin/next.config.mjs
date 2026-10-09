/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'export',
  trailingSlash: true,
  poweredByHeader: false,
  reactStrictMode: true,
  transpilePackages: ['@janeway/ui'],
  images: { unoptimized: true },
}

export default nextConfig
