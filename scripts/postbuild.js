'use strict';

require('node:fs').chmodSync(require('node:path').join(__dirname, '..', 'dist', 'cli', 'download.js'), 0o755);
