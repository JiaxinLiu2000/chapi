/**
 * One-off screenshots of cloakbrowser's active pages — the phone's stand-in for the
 * web UI's live browser panel (a screencast can't stream into a chat app).
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import CDP from 'chrome-remote-interface';
import { config } from '../config.js';

const HOST = '127.0.0.1';

export interface BrowserShot {
  file: string;
  url: string;
  title: string;
}

interface Target {
  id: string;
  type: string;
  url: string;
  title: string;
}

const idle = (url: string) => {
  const u = url.trim().toLowerCase();
  return u === '' || u === 'about:blank' || u === 'about:newtab' || u.startsWith('chrome://') || u.startsWith('devtools://');
};

/** Screenshot up to `max` non-blank pages. Throws a readable error when the browser isn't running. */
export async function captureBrowser(max = 2): Promise<BrowserShot[]> {
  let targets: Target[];
  try {
    const res = await fetch(`http://${HOST}:${config.cloakbrowserCdpPort}/json`, { signal: AbortSignal.timeout(2500) });
    targets = (await res.json()) as Target[];
  } catch {
    throw new Error('浏览器没在运行（cloakbrowser 未启动）');
  }
  const pages = targets.filter((t) => t.type === 'page' && !idle(t.url)).slice(0, max);
  const dir = path.join(os.tmpdir(), 'chapi-remote-shots');
  await fs.mkdir(dir, { recursive: true });
  const out: BrowserShot[] = [];
  for (const [i, t] of pages.entries()) {
    // A short-lived CDP client on just this target; never touches the agent's own connection.
    const client = (await CDP({ host: HOST, port: config.cloakbrowserCdpPort, target: t.id })) as unknown as {
      Page: { captureScreenshot(o: Record<string, unknown>): Promise<{ data: string }> };
      close(): Promise<void>;
    };
    try {
      const { data } = await Promise.race([
        client.Page.captureScreenshot({ format: 'jpeg', quality: 70, captureBeyondViewport: false }),
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error('截图超时')), 8000)),
      ]);
      const file = path.join(dir, `browser-${Date.now()}-${i + 1}.jpg`);
      await fs.writeFile(file, Buffer.from(data, 'base64'));
      out.push({ file, url: t.url, title: t.title });
    } finally {
      await client.close().catch(() => undefined);
    }
  }
  return out;
}
