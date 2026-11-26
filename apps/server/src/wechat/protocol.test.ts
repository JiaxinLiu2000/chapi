import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { IlinkClient, ItemType, UploadMediaType, aesPaddedSize, decryptAesEcb, encryptAesEcb, parseAesKey, parseLossless } from './protocol.js';

type Call = { url: string; init?: RequestInit };

function fakeFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    return handler(url, init);
  }) as typeof fetch;
  return { fn, calls };
}

describe('protocol helpers', () => {
  it('keeps uint64 message ids lossless', () => {
    const r = parseLossless<{ message_id: string; msgs: Array<{ message_id: string; seq: number }> }>(
      '{"message_id": 7364628937469283746, "msgs":[{"message_id":12345678901234567890,"seq":3}]}',
    );
    expect(r.message_id).toBe('7364628937469283746');
    expect(r.msgs[0]!.message_id).toBe('12345678901234567890');
    expect(r.msgs[0]!.seq).toBe(3);
  });

  it('AES-128-ECB round-trips and padded size matches', () => {
    const key = crypto.randomBytes(16);
    const plain = Buffer.from('hello wechat 你好'.repeat(5));
    const enc = encryptAesEcb(plain, key);
    expect(enc.length).toBe(aesPaddedSize(plain.length));
    expect(decryptAesEcb(enc, key).equals(plain)).toBe(true);
  });

  it('parses both aes_key encodings', () => {
    const raw = crypto.randomBytes(16);
    expect(parseAesKey(raw.toString('base64')).equals(raw)).toBe(true);
    expect(parseAesKey(Buffer.from(raw.toString('hex')).toString('base64')).equals(raw)).toBe(true);
  });
});

describe('IlinkClient', () => {
  it('sends text with bot token headers, context token and base_info', async () => {
    const { fn, calls } = fakeFetch(() => new Response('{"ret":0,"message_id":9007199254740993123}'));
    const c = new IlinkClient('https://ilinkai.weixin.qq.com', 'tok123', fn);
    const id = await c.sendText('user@im.wechat', '你好', 'ctx-1');
    expect(id).toBe('9007199254740993123');
    const call = calls[0]!;
    expect(call.url).toBe('https://ilinkai.weixin.qq.com/ilink/bot/sendmessage');
    const h = call.init!.headers as Record<string, string>;
    expect(h.Authorization).toBe('Bearer tok123');
    expect(h.AuthorizationType).toBe('ilink_bot_token');
    expect(h['iLink-App-Id']).toBe('bot');
    expect(h['X-WECHAT-UIN']).toBeTruthy();
    const body = JSON.parse(call.init!.body as string);
    expect(body.msg).toMatchObject({ to_user_id: 'user@im.wechat', message_type: 2, message_state: 2, context_token: 'ctx-1' });
    expect(body.msg.item_list).toEqual([{ type: ItemType.TEXT, text_item: { text: '你好' } }]);
    expect(body.base_info.bot_agent).toMatch(/^Chapi\//);
  });

  it('throws on a non-zero ret', async () => {
    const { fn } = fakeFetch(() => new Response('{"ret":-2,"errmsg":"context expired"}'));
    await expect(new IlinkClient(undefined, 't', fn).sendText('u', 'x', 'c')).rejects.toThrow(/ret=-2/);
  });

  it('getUpdates treats a client-side timeout as an empty poll', async () => {
    const { fn } = fakeFetch((_u, init) => new Promise((_res, rej) => {
      init?.signal?.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    }));
    const r = await new IlinkClient(undefined, 't', fn).getUpdates('buf-1', 30);
    expect(r).toEqual({ ret: 0, msgs: [], get_updates_buf: 'buf-1' });
  });

  it('uploads media encrypted and returns the CDN download param', async () => {
    let uploaded: Buffer | null = null;
    let uploadKeyHex = '';
    const { fn, calls } = fakeFetch(async (url, init) => {
      if (url.endsWith('ilink/bot/getuploadurl')) {
        uploadKeyHex = JSON.parse(init!.body as string).aeskey;
        return new Response('{"upload_full_url":"https://cdn.example/upload?x=1"}');
      }
      uploaded = Buffer.from(init!.body as Uint8Array);
      return new Response('', { status: 200, headers: { 'x-encrypted-param': 'DL-PARAM' } });
    });
    const plain = Buffer.from('PNG-bytes'.repeat(10));
    const up = await new IlinkClient(undefined, 't', fn).uploadMedia(plain, 'u', UploadMediaType.IMAGE);
    expect(up.downloadParam).toBe('DL-PARAM');
    expect(up.rawSize).toBe(plain.length);
    expect(calls[1]!.url).toBe('https://cdn.example/upload?x=1');
    expect(decryptAesEcb(uploaded!, Buffer.from(uploadKeyHex, 'hex')).equals(plain)).toBe(true);
    expect(up.aeskeyHex).toBe(uploadKeyHex);
  });

  it('downloads and decrypts inbound media', async () => {
    const key = crypto.randomBytes(16);
    const plain = Buffer.from('a photo');
    const { fn, calls } = fakeFetch(() => new Response(new Uint8Array(encryptAesEcb(plain, key))));
    const out = await new IlinkClient(undefined, 't', fn).downloadMedia({ encrypt_query_param: 'q=1', aes_key: key.toString('base64') });
    expect(out.equals(plain)).toBe(true);
    expect(calls[0]!.url).toContain('/download?encrypted_query_param=q%3D1');
  });
});
