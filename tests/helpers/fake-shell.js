// A small shell for tests, behind the same two doors as a real one: text in,
// text out, in the order a terminal would give it.
//
// It understands only what the session protocol and the tests send: printf,
// pwd, cd, export, echo, true, false, a few commands that print in pieces, and
// the engine's own start-up lines. What it does not know prints
// `sh: <name>: not found` and fails with 127, as a shell would.
//
// The options make it behave like the servers that caused trouble:
//
//   echo           echoes every line it receives, before running any of them,
//                  as a terminal with echo on does.
//   honorsStty     `stty -echo` turns the echo off. A bastion has no stty.
//   honorsPrompt   `PS1=''` removes the prompt. A bastion keeps its own.
//   prompt         printed after every line, the way an interactive shell does.
//   escapes        wraps output and prompt in bracketed-paste and colour codes.
//   chunkSize      delivers output in pieces of this many characters, so a
//                  marker can arrive split in two.
//   startupDelay   runs nothing for this long, while still echoing: a shell
//                  that is not ready yet.
//   editingOffDropsUnread  `set +o emacs` drops the lines received but not
//                  yet run, as bash 4.2 on CentOS 7 does: line editing had
//                  read them ahead, and they go with it.
//
// Commands on one line may be separated by `; `.
import { EventEmitter } from 'node:events';

const ESC = String.fromCharCode(27);
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

/** Splits a command line into words, honouring single and double quotes. */
function words(text) {
  const found = [];
  for (const match of text.matchAll(/'([^']*)'|"([^"]*)"|(\S+)/g)) {
    found.push({ text: match[1] ?? match[2] ?? match[3], quoted: match[1] !== undefined });
  }
  return found;
}

/** Splits a command line on `;` outside quotes. */
function commands(line) {
  return line.match(/(?:'[^']*'|"[^"]*"|[^;'"])+/g) ?? [];
}

export class FakeShell {
  /**
   * @param {object} options - See the header
   * @param {(text: string) => void} emit - Called with what the shell prints
   */
  constructor(options, emit) {
    this.options = {
      echo: false,
      honorsStty: true,
      honorsPrompt: true,
      prompt: '',
      escapes: false,
      chunkSize: 0,
      startupDelay: 0,
      editingOffDropsUnread: false,
      ...options
    };
    this.emitRaw = emit;
    this.echo = this.options.echo;
    this.prompt = this.options.prompt;
    this.cwd = '/home/user';
    this.env = { PATH: '/usr/local/bin:/usr/bin:/bin', USER: 'user', HOME: '/home/user' };
    this.vars = { __mcp_status: '0' };
    this.status = 0;
    this.pending = '';
    this.queue = Promise.resolve();
    this.started = Date.now();
  }

  /** What the engine wrote. */
  input(text) {
    this.pending += text;
    const lines = [];
    let cut;
    while ((cut = this.pending.indexOf('\n')) >= 0) {
      lines.push(this.pending.slice(0, cut));
      this.pending = this.pending.slice(cut + 1);
    }
    if (lines.length === 0) return;
    // A terminal echoes on receipt, before the shell has read anything.
    if (this.echo) for (const line of lines) this.out(`${this.prompt}${line}\n`);
    this.queue = this.queue.then(async () => {
      const ready = this.started + this.options.startupDelay;
      if (Date.now() < ready) await wait(ready - Date.now());
      for (const line of lines) {
        let dropUnread = false;
        for (const command of commands(line)) {
          await this.run(command);
          if (this.options.editingOffDropsUnread && command.trim().startsWith('set +o emacs')) dropUnread = true;
        }
        if (this.prompt) this.out(this.options.escapes ? `${ESC}[?2004h${ESC}[32m${this.prompt}${ESC}[0m` : this.prompt, true);
        if (dropUnread) break;
      }
    });
  }

  /** Writes to the engine, in pieces when asked to. */
  out(text, raw = false) {
    const wire = raw ? text : text.replace(/\n/g, '\r\n');
    const size = this.options.chunkSize;
    if (!size) return this.emitRaw(wire);
    for (let i = 0; i < wire.length; i += size) this.emitRaw(wire.slice(i, i + size));
  }

  /** Output of a command, wrapped the way a bracketed-paste terminal does. */
  print(text) {
    this.out(this.options.escapes ? `${ESC}[?2004l\r${text}` : text);
  }

  expand(text) {
    return text.replace(/\$(\w+)/g, (_, name) => this.vars[name] ?? this.env[name] ?? '');
  }

  format(args) {
    const [format, ...rest] = args;
    let index = 0;
    return format.text.replace(/\\n/g, '\n').replace(/%s/g, () => this.expand(rest[index++]?.text ?? ''));
  }

  async run(line) {
    const trimmed = line.trim();
    const [first, ...args] = words(trimmed);
    const name = first?.text;
    if (!name) return;
    if (name === 'set' || name === '[' || name.startsWith('#')) return;
    if (trimmed.startsWith('stty -echo')) { if (this.options.honorsStty) this.echo = false; return; }
    if (trimmed.startsWith("PS1=''")) { if (this.options.honorsPrompt) this.prompt = ''; return; }
    if (name === '__mcp_status=$?') { this.vars.__mcp_status = String(this.status); return; }
    switch (name) {
      case 'printf': this.print(this.format(args)); this.status = 0; return;
      case 'pwd': this.print(`${this.cwd}\n`); this.status = 0; return;
      case 'cd': this.cwd = this.expand(args[0]?.text ?? this.env.HOME); this.status = 0; return;
      case 'export': {
        const [key, ...value] = (args[0]?.text ?? '').split('=');
        this.env[key] = value.join('=');
        this.status = 0;
        return;
      }
      case 'echo': this.print(`${args.map(word => this.expand(word.text)).join(' ')}\n`); this.status = 0; return;
      case 'true': this.status = 0; return;
      case 'false': this.status = 1; return;
      case 'colour': this.print(`${ESC}[31mred${ESC}[0m and ${ESC}]0;title\u0007plain\n`); this.status = 0; return;
      case 'slow':
        for (const piece of ['one', 'two', 'three']) {
          this.print(`${piece}\n`);
          await wait(120);
        }
        this.status = 0;
        return;
      case 'hang': await new Promise(() => {}); return;
      default:
        this.print(`sh: ${name}: not found\n`);
        this.status = 127;
    }
  }
}

/**
 * The pieces of an ssh2 client that a session uses, in front of a FakeShell.
 * @param {object} [options] - See the header
 * @returns {{requestShell: () => Promise<EventEmitter>, shells: FakeShell[]}} The client stand-in and the shells it opened
 */
export function fakeSsh(options = {}) {
  const shells = [];
  return {
    shells,
    async requestShell() {
      const stream = new EventEmitter();
      stream.stderr = new EventEmitter();
      const shell = new FakeShell(options, text => setImmediate(() => stream.emit('data', Buffer.from(text))));
      shells.push(shell);
      stream.write = text => shell.input(text);
      stream.end = () => {};
      return stream;
    }
  };
}
