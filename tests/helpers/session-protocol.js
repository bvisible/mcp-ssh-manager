// Answers the engine's session protocol for a test SSH server that does not run
// a shell: the readiness marker, then each command's start and end markers.
//
// The engine spells every marker as two printf arguments (`start_ <id>`), so a
// server that echoes its input never gives one back whole; only a real answer
// carries it. This answers the way a shell would: markers on lines of their
// own, the command's output between the start and the end, status 0.
//
// Where the two arguments are not found, nothing is written.

/**
 * @param {string} input - What the engine wrote to the shell
 * @param {(text: string) => void} write - Writes to the engine
 * @param {string} [output] - What every command prints
 */
export function answerSessionProtocol(input, write, output = '/fixture') {
  const ready = input.match(/\bready_ ([a-f0-9]+)/);
  const start = input.match(/\bstart_ ([a-f0-9]+)/);
  const end = input.match(/\bcmd_ ([a-f0-9]+)/);
  if (ready) write(`\nready_${ready[1]}\n`);
  if (start && end) write(`\nstart_${start[1]}\n${output}\n\ncmd_${end[1]}:0\n`);
}
