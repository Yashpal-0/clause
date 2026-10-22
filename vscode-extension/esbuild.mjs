// Bundles the extension (and, with --tests, the integration tests) to CommonJS.
// The extension host loads extensions with require(), and `vscode` only exists
// inside it, so it is left external.
import { build } from 'esbuild';
import { globSync, rmSync } from 'node:fs';

const common = { bundle: true, platform: 'node', format: 'cjs', target: 'node22', external: ['vscode'], sourcemap: true, logLevel: 'info' };

await build({ ...common, entryPoints: ['src/extension.ts'], outfile: 'dist/extension.js' });

if (process.argv.includes('--tests')) {
  // A test that was renamed or deleted must not keep running from an old build.
  rmSync('out/test', { recursive: true, force: true });
  await build({
    ...common,
    entryPoints: globSync('test/integration/**/*.test.ts'),
    outdir: 'out/test/integration',
    // mocha is supplied by the test runner inside the extension host.
    external: ['vscode', 'mocha'],
  });
}
