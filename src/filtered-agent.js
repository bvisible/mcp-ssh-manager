// Select one public identity while the original agent retains the private key
// and handles signing and any user authorization prompts.
import ssh2 from 'ssh2';
const { BaseAgent, utils } = ssh2;

/** @param {any} value @returns {Buffer} */
function publicBytes(value) {
  const key = value && typeof value.getPublicSSH === 'function'
    ? value : utils.parseKey(value);
  if (key instanceof Error) throw key;
  if (!key || Array.isArray(key)) throw new Error('Expected one SSH public key');
  return key.getPublicSSH();
}

export class FilteredAgent extends BaseAgent {
  /** @param {import('ssh2').BaseAgent} delegate @param {Buffer} publicKey */
  constructor(delegate, publicKey) {
    super();
    this.delegate = delegate;
    this.allowedKey = publicBytes(publicKey);
  }

  /** @param {function} callback */
  getIdentities(callback) {
    this.delegate.getIdentities((error, keys) => {
      if (error) return callback(error);
      let selected;
      try {
        selected = keys.find(key => publicBytes(key).equals(this.allowedKey));
        if (!selected) throw new Error('Configured public key is not available in SSH Agent');
      } catch (error) {
        return callback(error);
      }
      callback(null, [selected]);
    });
  }

  /** @param {any} publicKey @param {Buffer} data @param {any} options @param {function} [callback] */
  sign(publicKey, data, options, callback) {
    if (typeof options === 'function') {
      callback = options;
      options = undefined;
    }
    try {
      if (!publicBytes(publicKey).equals(this.allowedKey)) {
        throw new Error('SSH Agent signing identity does not match configured public key');
      }
    } catch (error) {
      return callback(error);
    }
    this.delegate.sign(publicKey, data, options, callback);
  }
}
