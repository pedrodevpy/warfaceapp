// Made by scripts/release-key.js. The public key is not a secret.
module.exports = {
  // The public repository that holds the release files.
  RELEASES: 'pedrodevpy/warfaceapp',
  BUNDLE_ID: 'co.daviddiaz.switchboard',

  // Each update must have a signature from the private half of this key.
  PUBLIC_KEY: `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEANLgFDFPTnQBvwCNBwjYQeAuaiVaDoOMjdICcx41bSNQ=
-----END PUBLIC KEY-----`,
};
