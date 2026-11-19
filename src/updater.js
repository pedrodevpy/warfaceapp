// Self-update for a build with no Apple signature.
// The standard Electron updater needs an Apple signature, so this one is written for
// Switchboard. A release is three files in the public downloads repository:
//   manifest.json       version, file name, size and SHA-256 of the zip
//   manifest.json.sig   Ed25519 signature of manifest.json, made with a key that only
//                       the publisher has (see scripts/release.js)
//   Switchboard-arm64.zip
// The app accepts an update only if the signature is valid and the zip matches the manifest.
const { app, net } = require('electron');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { PUBLIC_KEY, RELEASES, BUNDLE_ID } = require('./update-config');

const BASE = `https://github.com/${RELEASES}/releases/latest/download`;
const CHECK_AFTER_START = 30 * 1000;
const CHECK_EVERY = 4 * 60 * 60 * 1000;
const MAX_SIZE = 600 * 1024 * 1024;

// Runs after the app quits: waits for the process to end, replaces the app, opens it again.
const APPLY_SCRIPT = `#!/bin/sh
PID="$1"; NEW="$2"; APP="$3"; ROOT="$4"
while kill -0 "$PID" 2>/dev/null; do sleep 0.3; done
/usr/bin/rsync -a --delete "$NEW/" "$APP/" && /usr/bin/open "$APP"
/bin/rm -rf "$ROOT"
`;

// True if version a is newer than version b. Both are "1.2.3".
function newer(a, b) {
  const x = String(a).split('.').map(Number);
  const y = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  }
  return false;
}

function verifyManifest(raw, signature) {
  const ok = crypto.verify(null, raw, PUBLIC_KEY, Buffer.from(String(signature).trim(), 'base64'));
  if (!ok) throw new Error('The update has no valid signature.');
  const m = JSON.parse(raw.toString('utf8'));
  const valid =
    /^\d+\.\d+\.\d+$/.test(m.version) &&
    /^[\w.-]+\.zip$/.test(m.file) &&
    /^[0-9a-f]{64}$/.test(m.sha256) &&
    Number.isInteger(m.size) &&
    m.size > 0 &&
    m.size <= MAX_SIZE;
  if (!valid) throw new Error('The update description is not valid.');
  return m;
}

function createUpdater({ onChange }) {
  // status: idle | checking | downloading | ready | error | blocked
  const state = { status: 'idle', version: null, error: null, checkedAt: null };
  const bundle = path.resolve(app.getPath('exe'), '..', '..', '..');
  let staged = null; // { root, appPath }
  let busy = false;

  const set = (patch) => {
    Object.assign(state, patch);
    onChange({ ...state });
  };

  function blockedReason() {
    if (process.platform !== 'darwin') return 'Updates are managed separately on Windows.';
    if (!app.isPackaged) return 'This is a development run.';
    if (bundle.includes('/AppTranslocation/')) return 'Move Switchboard to the Applications folder, then open it again.';
    try {
      fs.accessSync(bundle, fs.constants.W_OK);
    } catch {
      return 'Switchboard cannot change its own files in this folder.';
    }
    return null;
  }

  async function fetchSmall(name, max) {
    const res = await net.fetch(`${BASE}/${name}`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`The update server answered ${res.status}.`);
    const data = Buffer.from(await res.arrayBuffer());
    if (data.length > max) throw new Error('The update description is too large.');
    return data;
  }

  async function download(manifest) {
    const root = path.join(app.getPath('userData'), 'updates');
    // /bin/rm, not fs.rm: Electron reads an .asar file as a folder, which confuses fs.rm.
    spawnSync('/bin/rm', ['-rf', root]);
    fs.mkdirSync(root, { recursive: true });

    const zip = path.join(root, 'update.zip');
    const res = await net.fetch(`${BASE}/${manifest.file}`, { cache: 'no-store' });
    if (!res.ok || !res.body) throw new Error(`The update server answered ${res.status}.`);
    const hash = crypto.createHash('sha256');
    let size = 0;
    const meter = new Transform({
      transform(chunk, _encoding, done) {
        size += chunk.length;
        if (size > manifest.size) return done(new Error('The download is larger than the signed release.'));
        hash.update(chunk);
        done(null, chunk);
      },
    });
    await pipeline(Readable.fromWeb(res.body), meter, fs.createWriteStream(zip));
    if (size !== manifest.size || hash.digest('hex') !== manifest.sha256) {
      throw new Error('The download does not match the signed release.');
    }

    const out = path.join(root, 'app');
    fs.mkdirSync(out);
    if (spawnSync('/usr/bin/ditto', ['-x', '-k', zip, out]).status !== 0) throw new Error('The update did not unpack.');
    spawnSync('/bin/rm', ['-f', zip]);

    const appPath = path.join(out, 'Switchboard.app');
    const plist = path.join(appPath, 'Contents', 'Info.plist');
    const read = (key) => spawnSync('/usr/bin/plutil', ['-extract', key, 'raw', plist], { encoding: 'utf8' }).stdout.trim();
    if (read('CFBundleIdentifier') !== BUNDLE_ID || read('CFBundleShortVersionString') !== manifest.version) {
      throw new Error('The download is not the expected app.');
    }
    staged = { root, appPath };
  }

  async function check() {
    if (busy || staged) return state;
    const reason = blockedReason();
    if (reason) {
      set({ status: 'blocked', error: reason });
      return state;
    }
    busy = true;
    set({ status: 'checking', error: null });
    try {
      const [raw, signature] = await Promise.all([fetchSmall('manifest.json', 64 * 1024), fetchSmall('manifest.json.sig', 1024)]);
      const manifest = verifyManifest(raw, signature.toString('utf8'));
      if (manifest.arch && manifest.arch !== process.arch) throw new Error(`This release is for ${manifest.arch} Macs.`);
      if (!newer(manifest.version, app.getVersion())) {
        set({ status: 'idle', version: null, checkedAt: Date.now() });
        return state;
      }
      set({ status: 'downloading', version: manifest.version, checkedAt: Date.now() });
      await download(manifest);
      set({ status: 'ready' });
    } catch (err) {
      set({ status: 'error', error: String(err.message || err) });
    } finally {
      busy = false;
    }
    return state;
  }

  // Starts the script that replaces the app. The caller must quit the app after this.
  function apply() {
    if (!staged) return false;
    const script = path.join(staged.root, 'apply.sh');
    fs.writeFileSync(script, APPLY_SCRIPT, { mode: 0o700 });
    spawn('/bin/sh', [script, String(process.pid), staged.appPath, bundle, staged.root], {
      detached: true,
      stdio: 'ignore',
    }).unref();
    return true;
  }

  function start() {
    setTimeout(check, CHECK_AFTER_START);
    setInterval(check, CHECK_EVERY);
  }

  return { check, apply, start, state: () => ({ ...state }) };
}

module.exports = { createUpdater, verifyManifest, newer };
