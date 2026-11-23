// Small JSON config store in the user data folder.
const fs = require('node:fs');
const path = require('node:path');
const { app } = require('electron');
const { presetById, starters } = require('./services');

const file = () => path.join(app.getPath('userData'), 'config.json');

function defaults() {
  const services = starters.map((id) => {
    const p = presetById.get(id);
    return { id, preset: id, name: p.name, url: p.url };
  });
  return {
    services,
    activeId: services[0].id,
    bounds: { width: 1280, height: 820 },
    notificationsEnabled: true,
    soundEnabled: true,
  };
}

function load() {
  try {
    const saved = JSON.parse(fs.readFileSync(file(), 'utf8'));
    if (!Array.isArray(saved.services)) throw new Error('bad config');
    return { ...defaults(), ...saved };
  } catch {
    return defaults();
  }
}

function write(cfg) {
  const target = file();
  const tmp = `${target}.tmp`;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2));
  fs.renameSync(tmp, target);
}

let timer = null;
function save(cfg) {
  clearTimeout(timer);
  timer = setTimeout(() => write(cfg), 250);
}

function flush(cfg) {
  clearTimeout(timer);
  write(cfg);
}

module.exports = { load, save, flush };
