import { execFileSync } from 'node:child_process';
import { cp, mkdir, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { build } from 'esbuild';

const root = resolve(import.meta.dirname, '..');
const output = resolve(root, 'deploy/prospector-prebuilt');

await rm(output, { recursive: true, force: true });
await mkdir(resolve(output, 'dist-server/adapters'), { recursive: true });
await build({
  entryPoints: [resolve(root, 'server/online.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  outfile: resolve(output, 'dist-server/adapters/online.cjs'),
});
await cp(resolve(root, 'dist-admin'), resolve(output, 'dist-admin'), { recursive: true });
await writeFile(resolve(output, 'SOURCE_COMMIT.txt'), `${execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()}\n`);
