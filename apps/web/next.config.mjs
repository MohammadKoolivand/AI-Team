import path from 'node:path';
import {fileURLToPath} from 'node:url';
/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Use a separate directory when validating alongside the running dev server.
  distDir:process.env.TEAMFORGE_NEXT_DIST_DIR||'.next',
  outputFileTracingRoot:path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..'),
  async rewrites(){return [{source:'/api/:path*',destination:'http://127.0.0.1:8787/api/:path*'}];}
};
export default nextConfig;
