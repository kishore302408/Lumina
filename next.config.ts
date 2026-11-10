import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  // Bundle a minimal server so the Electron app runs without node_modules.
  output: "standalone",
  cacheComponents: true,
  partialPrefetching: true,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
