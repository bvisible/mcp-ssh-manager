/**
 * A shim so the components carried over from TransHub keep their imports.
 *
 * They were written against `@/types/electron`, which is where that project
 * declares the shapes its IPC bridge returns. Nothing here talks to Electron —
 * the names are kept so the copied components need no edit, which is the whole
 * point: a component nobody had to touch is a component that still looks and
 * behaves like the original.
 */
export type { ServerConfig, ServerAccount, RemoteFileInfo } from '@/lib/api';
