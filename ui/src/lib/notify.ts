/**
 * Desktop notifications for approval requests.
 *
 * ## Why this is not optional
 *
 * The approval feature's whole premise is that an agent pauses and waits for a
 * human. If that human is in another window — which they are, because they
 * asked the agent to do the work so they could do something else — the request
 * sits unseen until it times out and is denied. A queue nobody is told about is
 * a queue that only ever produces refusals.
 *
 * ## What is notified, and what is not
 *
 * Only requests that are **waiting on a decision**. Not command output, not
 * transfers, not health probes: those are things you look at when you choose
 * to, and a notification for each would train the operator to dismiss all of
 * them — including the one that mattered.
 *
 * Destructive requests are marked as such and asked to stay on screen, because
 * `rm -rf` on production and `systemctl status` are not the same interruption.
 */

/** Kept so a request that is answered elsewhere can have its notification closed. */
const open = new Map<string, Notification>();

let permission: NotificationPermission | 'unsupported' =
  typeof Notification === 'undefined' ? 'unsupported' : Notification.permission;

/**
 * Ask once, when there is something worth asking for.
 *
 * Deliberately not on page load: a permission prompt that appears before the
 * user has seen what the page does is the prompt everyone denies. The desktop
 * app grants it without asking, since installing the app was the consent.
 */
export async function ensurePermission(): Promise<boolean> {
  if (permission === 'unsupported') return false;
  if (permission === 'granted') return true;
  if (permission === 'denied') return false;
  try {
    permission = await Notification.requestPermission();
    return permission === 'granted';
  } catch {
    return false;
  }
}

export interface ApprovalNotice {
  id: string;
  server: string;
  tool: string;
  command?: string;
  destructive: boolean;
}

/**
 * Raise a notification for one waiting request.
 *
 * @param request - What the agent wants to do
 * @param onClick - Bring the operator to the queue
 */
export function notifyApproval(request: ApprovalNotice, onClick: () => void): void {
  if (permission !== 'granted' || open.has(request.id)) return;

  // The command matters more than any of the wording around it, so it is the
  // body, truncated at a length that still shows what is being destroyed.
  const command = request.command?.trim() ?? '';
  const body = command.length > 140 ? `${command.slice(0, 137)}…` : command || request.tool;

  try {
    const notification = new Notification(
      request.destructive
        ? `${request.server}: destructive command waiting`
        : `${request.server}: waiting for you`,
      {
        body,
        tag: request.id,
        // A destructive request stays until it is dealt with; an ordinary one
        // may auto-dismiss. The operating system decides how literally to take
        // this, but the intent is worth stating.
        requireInteraction: request.destructive,
        silent: !request.destructive,
      }
    );
    notification.onclick = () => {
      window.focus();
      onClick();
      notification.close();
    };
    open.set(request.id, notification);
  } catch {
    // Notifications can throw where the platform has none. Failing to notify
    // must never break the queue itself.
  }
}

/**
 * Close the notification for a request that is no longer waiting — answered
 * here, answered elsewhere, or expired because the agent gave up. Leaving it on
 * screen invites a decision on something already decided.
 *
 * @param id - The request that is done
 */
export function clearApproval(id: string): void {
  const notification = open.get(id);
  if (!notification) return;
  try {
    notification.close();
  } catch {
    /* already gone */
  }
  open.delete(id);
}

/** Close everything, for a page that is going away. */
export function clearAll(): void {
  for (const id of [...open.keys()]) clearApproval(id);
}
