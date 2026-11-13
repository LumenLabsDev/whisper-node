'use strict';

// Build step (run once, online): copy the whisper.cpp files the app needs into resources/bin/whisper
// and add the Visual C++ runtime next to them, so the installed app runs offline on a clean Windows.
//   node scripts/prepare-resources.js [--flavor cpu|blas] [--vcruntime <VC\Redist\MSVC\<ver>\x64 folder>|system]
// Models: WHISPER_NODE_MODELS=<this folder>/resources/models npx whisper-node   (choose base-q5_1 or small-q5_1)
const fs = require('node:fs');
const path = require('node:path');

const arg = (name, fallback) => {
  const index = process.argv.indexOf('--' + name);
  return index >= 0 ? process.argv[index + 1] : fallback;
};
const flavor = arg('flavor', 'cpu');
const vcruntime = arg('vcruntime', 'system');
const pkg = path.dirname(require.resolve('@lumen-labs-dev/whisper-node/package.json'));
const native = path.join(pkg, 'lib', 'whisper.cpp');
const source = path.join(native, flavor === 'blas' ? 'BlasWin64' : 'Win64');
const target = path.join(__dirname, '..', 'resources', 'bin', 'whisper');
// Executables used by the package and the DLLs they load; test tools and other examples are left out.
const NEEDED = /^(whisper-(cli|server)\.exe|whisper\.dll|ggml(-[a-z0-9_-]+)?\.dll|libopenblas\.dll)$/i;

fs.rmSync(target, { recursive: true, force: true });
fs.mkdirSync(target, { recursive: true });
for (const name of fs.readdirSync(source)) {
  if (NEEDED.test(name)) fs.copyFileSync(path.join(source, name), path.join(target, name));
}
// Redistributed binaries keep their licenses.
fs.copyFileSync(path.join(native, 'LICENSE'), path.join(target, 'whisper.cpp-LICENSE'));
for (const name of fs.readdirSync(path.join(native, 'licenses'))) {
  fs.copyFileSync(path.join(native, 'licenses', name), path.join(target, name));
}
const { installVcRuntime } = require('@lumen-labs-dev/whisper-node/packages/whisper-native');
installVcRuntime(target, 'x64', vcruntime, { log: console.log });
fs.mkdirSync(path.join(__dirname, '..', 'resources', 'models'), { recursive: true });
console.log('Native files ready in ' + target);
