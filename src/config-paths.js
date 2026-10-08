import os from 'os';
import path from 'path';

/**
 * The directory that holds this user's settings and state: SSH_MANAGER_HOME,
 * or ~/.ssh-manager. Read at call time so a test or a host that sets the
 * variable after import still gets its own directory.
 * @returns {string}
 */
export function managerHome() {
  return process.env.SSH_MANAGER_HOME || path.join(os.homedir(), '.ssh-manager');
}
