/**
 * Metro is pointed at the repository root so this app can import the shared
 * protocol code in ../src directly, rather than keeping a second copy of it.
 *
 * A copy is the thing this whole plan exists to avoid: two implementations of
 * the NIP-59 sealing would drift, and the one that drifts silently is the one
 * handling private messages.
 */
const fs = require('fs');
const path = require('path');
const { getDefaultConfig } = require('expo/metro-config');

const projectRoot = __dirname;
const repoRoot = path.resolve(projectRoot, '..');

const config = getDefaultConfig(projectRoot);

// Watch the repo root so ../src and ../types are inside Metro's world.
config.watchFolders = [repoRoot];

// Resolve from this app first, then the repo root. The web app has its own
// node_modules and must not be the one satisfying React.
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(repoRoot, 'node_modules'),
];

/**
 * The shared code is TypeScript written for `moduleResolution: bundler`, so
 * its relative imports carry a `.js` extension for files that only exist as
 * `.ts`. Vite understands that; Metro takes the extension literally and looks
 * for a JavaScript file that was never written.
 *
 * Rather than rewrite several hundred imports in the web app - which would be
 * a change to shipped code for the benefit of a second front end - the
 * extension is mapped back here, and only when the TypeScript file actually
 * exists. Anything else falls through to Metro untouched.
 */
const TAURI_STUB = path.resolve(projectRoot, 'platform/tauri-stub.js');

const defaultResolveRequest = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  // The shared code reaches for Tauri behind an isNativeRuntime() guard, so
  // under React Native the import never runs - but Metro still has to resolve
  // it at bundle time, and the package is not installed here. The stub throws
  // if it is ever actually called, which it should not be.
  if (moduleName.startsWith('@tauri-apps/')) {
    return { type: 'sourceFile', filePath: TAURI_STUB };
  }

  if (moduleName.startsWith('.') && moduleName.endsWith('.js')) {
    const from = context.originModulePath
      ? path.dirname(context.originModulePath)
      : projectRoot;
    const base = path.resolve(from, moduleName.slice(0, -3));
    for (const candidate of [`${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts')]) {
      if (fs.existsSync(candidate)) {
        return { type: 'sourceFile', filePath: candidate };
      }
    }
  }
  return defaultResolveRequest
    ? defaultResolveRequest(context, moduleName, platform)
    : context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
