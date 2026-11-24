// The preset catalog. Each preset is a web app that Switchboard can host.
const icons = require('./icons.json');

const catalog = [
  ['whatsapp', 'WhatsApp', 'https://web.whatsapp.com/'],
  ['slack', 'Slack', 'https://slack.com/signin'],
  ['telegram', 'Telegram', 'https://web.telegram.org/a/'],
  ['discord', 'Discord', 'https://discord.com/app'],
  ['messenger', 'Messenger', 'https://www.messenger.com/'],
  ['googlemessages', 'Messages', 'https://messages.google.com/web/'],
  ['instagram', 'Instagram', 'https://www.instagram.com/direct/inbox/'],
  ['x', 'X', 'https://x.com/messages'],
  ['linkedin', 'LinkedIn', 'https://www.linkedin.com/messaging/'],
  ['gmail', 'Gmail', 'https://mail.google.com/'],
  ['googlecalendar', 'Calendar', 'https://calendar.google.com/'],
  ['notion', 'Notion', 'https://www.notion.so/'],
  ['linear', 'Linear', 'https://linear.app/'],
  ['claude', 'Claude', 'https://claude.ai/'],
];

const presets = catalog.map(([id, name, url]) => ({ id, name, url, icon: icons[id] || null }));
const presetById = new Map(presets.map((p) => [p.id, p]));

// The services that a new install starts with.
const starters = ['whatsapp', 'slack', 'telegram'];

module.exports = { presets, presetById, starters };
