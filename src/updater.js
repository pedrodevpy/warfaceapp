// Update checker for Switchboard on Windows and macOS.
const { app, net, shell } = require('electron');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { PUBLIC_KEY, RELEASES, BUNDLE_ID } = require('./update-config');

const isWin = process.platform === 'win32';
const GITHUB_API = `https://api.github.com/repos/${RELEASES}/releases/latest`;
const BASE = `https://github.com/${RELEASES}/releases/latest/download`;
const CHECK_AFTER_START = 30 * 1000;
const CHECK_EVERY = 4 * 60 * 60 * 1000;
const MAX_SIZE = 600 * 1024 * 1024;

const APPLY_SCRIPT = `#!/bin/sh
PID="$1"; NEW="$2"; APP="$3"; ROOT="$4"
while kill -0 "$PID" 2>/dev/null; do sleep 0.3; done
/usr/bin/rsync -a --delete "$NEW/" "$APP/" && /usr/bin/open "$APP"
/bin/rm -rf "$ROOT"
`;

// True if version a is newer than version b. Both are e.g. "0.2.5" or "v0.2.5".
function newer(a, b) {
  const clean = (v) => String(v || '').replace(/^v/i, '').split('.').map(Number);
  const x = clean(a);
  const y = clean(b);
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
  const state = {
    status: 'idle',
    version: null,
    error: null,
    checkedAt: null,
    downloadUrl: null,
    releaseUrl: null,
    notes: null,
  };
  const bundle = path.resolve(app.getPath('exe'), '..', '..', '..');
  let staged = null;
  let busy = false;

  const set = (patch) => {
    Object.assign(state, patch);
    onChange({ ...state });
  };

  async function checkWindows() {
    try {
      const res = await net.fetch(GITHUB_API, {
        headers: {
          'User-Agent': 'Switchboard-Updater',
          'Accept': 'application/vnd.github.v3+json',
        },
        cache: 'no-store',
      });
      if (res.status === 404) {
        // No releases published yet in this repo
        set({ status: 'idle', version: null, error: null, checkedAt: Date.now() });
        return state;
      }
      if (!res.ok) throw new Error(`El servidor de GitHub respondió con código ${res.status}`);
      const data = await res.json();
      const rawTag = data.tag_name || data.name || '';
      const releaseVersion = rawTag.replace(/^v/i, '').trim();

      if (!releaseVersion || !newer(releaseVersion, app.getVersion())) {
        set({ status: 'idle', version: null, error: null, checkedAt: Date.now() });
        return state;
      }

      let downloadUrl = data.html_url;
      if (Array.isArray(data.assets) && data.assets.length > 0) {
        const exeAsset =
          data.assets.find((a) => a.name.toLowerCase().endsWith('.exe')) || data.assets[0];
        if (exeAsset && exeAsset.browser_download_url) {
          downloadUrl = exeAsset.browser_download_url;
        }
      }

      set({
        status: 'ready',
        version: releaseVersion,
        releaseUrl: data.html_url,
        downloadUrl,
        notes: data.body || '',
        error: null,
        checkedAt: Date.now(),
      });
    } catch (err) {
      set({ status: 'error', error: String(err.message || err), checkedAt: Date.now() });
    }
    return state;
  }

  async function fetchSmall(name, max) {
    const res = await net.fetch(`${BASE}/${name}`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`The update server answered ${res.status}.`);
    const data = Buffer.from(await res.arrayBuffer());
    if (data.length > max) throw new Error('The update description is too large.');
    return data;
  }

  async function downloadMac(manifest) {
    const root = path.join(app.getPath('userData'), 'updates');
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
    if (busy) return state;
    busy = true;
    set({ status: 'checking', error: null });

    try {
      if (isWin) {
        await checkWindows();
      } else {
        if (!app.isPackaged) {
          set({ status: 'blocked', error: 'This is a development run.' });
          return state;
        }
        if (bundle.includes('/AppTranslocation/')) {
          set({ status: 'blocked', error: 'Move Switchboard to the Applications folder, then open it again.' });
          return state;
        }
        try {
          fs.accessSync(bundle, fs.constants.W_OK);
        } catch {
          set({ status: 'blocked', error: 'Switchboard cannot change its own files in this folder.' });
          return state;
        }

        const [raw, signature] = await Promise.all([
          fetchSmall('manifest.json', 64 * 1024),
          fetchSmall('manifest.json.sig', 1024),
        ]);
        const manifest = verifyManifest(raw, signature.toString('utf8'));
        if (manifest.arch && manifest.arch !== process.arch) throw new Error(`This release is for ${manifest.arch} Macs.`);
        if (!newer(manifest.version, app.getVersion())) {
          set({ status: 'idle', version: null, checkedAt: Date.now() });
          return state;
        }
        set({ status: 'downloading', version: manifest.version, checkedAt: Date.now() });
        await downloadMac(manifest);
        set({ status: 'ready' });
      }
    } catch (err) {
      set({ status: 'error', error: String(err.message || err), checkedAt: Date.now() });
    } finally {
      busy = false;
    }
    return state;
  }

  function apply() {
    if (isWin) {
      if (state.status !== 'ready') return false;
      const target = state.downloadUrl || state.releaseUrl || `https://github.com/${RELEASES}/releases`;
      shell.openExternal(target);
      return true;
    }

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
