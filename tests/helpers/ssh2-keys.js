// Ed25519 key pairs for tests, from ssh2's own generator, keeping only pairs
// that ssh2 can read back.
//
// ssh2 1.17.0's utils.generateKeyPairSync('ed25519') returns, about once in
// 600 calls, a pair one byte short (a 233-byte private blob instead of 234)
// whose private AND public halves both fail utils.parseKey ("Malformed OpenSSH
// private key"). A test that draws one key at load time then fails at random:
// the 4.1.0 release pipeline stopped on exactly that, after the same tests had
// passed on every Node version in pull request CI.
import ssh2 from 'ssh2';

const { utils } = ssh2;

/**
 * A fresh ed25519 pair whose private and public halves both parse.
 * @returns {{private: string, public: string}}
 */
export function ed25519Pair() {
  for (let attempt = 0; attempt < 20; attempt++) {
    const pair = utils.generateKeyPairSync('ed25519');
    if (!(utils.parseKey(pair.private) instanceof Error) && !(utils.parseKey(pair.public) instanceof Error)) {
      return pair;
    }
  }
  throw new Error('ssh2 produced 20 unreadable ed25519 keys in a row');
}
