/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // gzip responses from the Node server (no effect when a CDN/proxy already compresses).
  compress: true,
  // Ship smaller client bundles: tree-shake barrel imports from these packages so a
  // single `import { motion } from 'framer-motion'` doesn't pull the whole library.
  experimental: {
    optimizePackageImports: ['framer-motion'],
  },
};

export default nextConfig;
