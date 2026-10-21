'use strict';

const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const target = path.resolve(root, 'dist');
if (path.relative(root, target) !== 'dist') throw new Error('Invalid build output path');
fs.rmSync(target, { recursive: true, force: true });
