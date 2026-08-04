const fs = require('node:fs');
const path = require('node:path');

for (const dir of ['dist']) {
  const p = path.join(__dirname, '..', dir);
  if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
}
