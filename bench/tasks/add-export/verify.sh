#!/bin/sh
node -e "import('./math.js').then((m) => { if (typeof m.multiply !== 'function' || m.multiply(3, 4) !== 12 || m.multiply(-2, 5) !== -10) process.exit(1); })"
