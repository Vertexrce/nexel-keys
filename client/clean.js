const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const targets = ['nexel-emulator.exe', 'Nexel.exe', 'electron.exe'];

for (const exe of targets) {
  try {
    execFileSync('taskkill', ['/f', '/t', '/im', exe], { stdio: 'ignore' });
    console.log(`killed ${exe}`);
  } catch {
    // not running
  }
}

const dist = path.join(__dirname, 'dist');

try {
  fs.rmSync(dist, {
    recursive: true,
    force: true,
    maxRetries: 15,
    retryDelay: 250
  });
  console.log('dist cleared');
} catch (e) {
  console.error(`could not clear dist: ${e.code || e.message}`);
  console.error('close the packaged app, pause OneDrive, then retry');
  process.exit(1);
}