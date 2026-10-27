// Üretim derlemesi: giriş noktalarını tek dosyalık ESM JS'e paketler; npm bağımlılıkları dışarıda kalır,
// iç paket @sp/domain derlemeye dahil edilir. Çalışma anında tsx/TypeScript gerekmez.
import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';

const pkg = JSON.parse(await readFile(new URL('./package.json', import.meta.url), 'utf8'));
const external = Object.keys(pkg.dependencies).filter((d) => !d.startsWith('@sp/'));

await build({
  entryPoints: ['src/index.ts', 'src/worker.ts', 'src/migrate.ts', 'src/provision.ts'],
  outdir: 'dist',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  sourcemap: true,
  external: external.flatMap((d) => [d, `${d}/*`]),
  logLevel: 'info',
});
