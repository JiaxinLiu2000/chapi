import os from 'node:os';
import { config } from '../config.js';

/** Hosts the chapi web app is served from: loopback plus this machine's own LAN addresses. */
function webUIHosts(): Set<string> {
  const hosts = new Set(['localhost', '127.0.0.1', '[::1]']);
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list ?? []) hosts.add(ni.family === 'IPv6' ? `[${ni.address.toLowerCase()}]` : ni.address);
  }
  return hosts;
}

/**
 * A browser request from the chapi web app: http on the web port AND a host that is
 * this machine (loopback or one of its own LAN addresses). Any other site — even one
 * served on the same port — is refused, so a foreign page can't confirm SOPs (CSRF).
 */
export function fromWebUI(origin: string | undefined): boolean {
  if (!origin) return false;
  try {
    const u = new URL(origin);
    return u.protocol === 'http:' && Number(u.port || 80) === config.webPort && webUIHosts().has(u.hostname.toLowerCase());
  } catch {
    return false;
  }
}
