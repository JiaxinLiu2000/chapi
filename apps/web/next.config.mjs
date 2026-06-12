/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ['@chapi/shared'],
  eslint: { ignoreDuringBuilds: true },
  webpack: (config) => {
    // Resolve NodeNext-style ".js" relative imports in the TS workspace package.
    config.resolve.extensionAlias = {
      ...(config.resolve.extensionAlias ?? {}),
      '.js': ['.ts', '.tsx', '.js'],
    };
    return config;
  },
};

export default nextConfig;
