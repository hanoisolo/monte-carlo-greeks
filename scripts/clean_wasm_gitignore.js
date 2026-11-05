// wasm-pack writes a .gitignore containing "*" into its output directory on
// every build. The built artifacts must be committed so Vercel can deploy
// without a Rust toolchain, so that file is removed after each build.
import { rmSync } from 'node:fs';

const target = new URL('../src/wasm/.gitignore', import.meta.url);
rmSync(target, { force: true });
console.log('Removed src/wasm/.gitignore so WASM artifacts stay trackable.');
