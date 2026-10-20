#!/usr/bin/env node
/* eslint global-require: 0 */
/**
 * Downloads the prebuilt mailsync binary for the current platform into app/.
 *
 * `npm install` already does this, but only when the mailsync submodule is absent AND the
 * root postinstall actually ran. If you installed with --ignore-scripts, or the postinstall
 * died earlier on another dependency, the app starts and immediately shows
 * "Mailspring could not find the mailsync process" — this script is the missing step alone.
 *
 *   node scripts/fetch-mailsync.js            # download if app/mailsync is missing
 *   node scripts/fetch-mailsync.js --force    # always re-download
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const { execSync } = require('child_process');
const targz = require('targz');

const repoRoot = path.resolve(__dirname, '..');
const appDir = path.join(repoRoot, 'app');
const binaryPath = path.join(appDir, 'mailsync');
const force = process.argv.includes('--force');

// Same mapping as scripts/postinstall.js: the S3 layout is per-platform, not per-arch,
// except for Linux arm64 which has its own build.
const distDir = {
  'darwin-x64': 'osx',
  'darwin-arm64': 'osx',
  'win32-x64': 'win-ia32', // mailsync is still a 32-bit build on Windows
  'win32-ia32': 'win-ia32',
  'linux-x64': 'linux',
  'linux-arm64': 'linux-arm64',
}[`${process.platform}-${process.arch}`];

if (!distDir) {
  console.error(`No prebuilt mailsync for ${process.platform}-${process.arch}. Build it from the submodule instead.`);
  process.exit(1);
}

// Windows ships mailsync.exe (plus its DLLs), macOS/Linux ship an extensionless wrapper next to
// mailsync.bin — so "is it installed" cannot be a single path check.
const candidates = ['mailsync', 'mailsync.exe', 'mailsync.bin'].map((name) => path.join(appDir, name));
const present = candidates.find((file) => fs.existsSync(file));
if (present && !force) {
  console.log(`${path.relative(repoRoot, present)} already present (${fs.statSync(present).size} bytes) — nothing to do.`);
  process.exit(0);
}

let hash = null;
try {
  const out = execSync('git submodule status ./mailsync', { cwd: repoRoot }).toString();
  hash = (/[0-9a-f]{40}/.exec(out) || [])[0];
} catch {
  /* fall through to the index below */
}
if (!hash) {
  try {
    const out = execSync('git ls-tree HEAD mailsync', { cwd: repoRoot }).toString();
    hash = (/\b[0-9a-f]{40}\b/.exec(out) || [])[0];
  } catch {
    /* ignore */
  }
}
if (!hash) {
  console.error('Could not determine the mailsync submodule commit (run this from the repo root).');
  process.exit(1);
}

const short = hash.slice(0, 8);
const url = `https://mailspring-builds.s3.amazonaws.com/mailsync/${short}/${distDir}/mailsync.tar.gz`;
const tarball = path.join(appDir, 'mailsync.tar.gz');

console.log(`Downloading mailsync ${short} (${distDir}) from ${url}`);

function download(target, redirects = 0) {
  https
    .get(target, (res) => {
      if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location && redirects < 5) {
        res.resume();
        return download(new URL(res.headers.location, target).toString(), redirects + 1);
      }
      if (res.statusCode !== 200) {
        console.error(`\nDownload failed: HTTP ${res.statusCode}. The prebuilt for ${short}/${distDir} may not exist.`);
        res.resume();
        process.exit(1);
      }
      const file = fs.createWriteStream(tarball);
      res.pipe(file);
      file.on('finish', () => {
        file.close(() => {
          targz.decompress({ src: tarball, dest: `${appDir}/` }, (err) => {
            if (err) {
              console.error(`\nUnpacking failed: ${err.message}`);
              process.exit(1);
            }
            fs.rmSync(tarball, { force: true });
            if (process.platform !== 'win32') {
              candidates.forEach((file) => {
                if (fs.existsSync(file)) fs.chmodSync(file, 0o755);
              });
            }
            const installed = candidates.find((file) => fs.existsSync(file));
            if (!installed) {
              console.error('\nUnpacked, but no mailsync binary showed up in app/ — check the tarball contents.');
              process.exit(1);
            }
            console.log(`\nUnpacked ${path.relative(repoRoot, installed)} into app/. Start the app with: npm start`);
          });
        });
      });
    })
    .on('error', (err) => {
      console.error(`\nDownload failed: ${err.message}`);
      process.exit(1);
    });
}

download(url);
