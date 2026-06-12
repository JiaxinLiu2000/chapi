import OpenAI from 'openai';
import { settings } from '../secrets.js';

let client: OpenAI | null = null;
let cachedKey: string | undefined;

async function getClient(): Promise<OpenAI | null> {
  const key = await settings.getOpenAiKey();
  if (!key) return null;
  if (!client || cachedKey !== key) {
    client = new OpenAI({ apiKey: key });
    cachedKey = key;
  }
  return client;
}

export async function embeddingsAvailable(): Promise<boolean> {
  return Boolean(await settings.getOpenAiKey());
}

export async function embed(texts: string[]): Promise<number[][]> {
  const c = await getClient();
  if (!c) throw new Error('OpenAI API key 未配置（请在设置中填写）。');
  const model = (await settings.getModels()).embedding;
  const res = await c.embeddings.create({ model, input: texts });
  return res.data.map((d) => d.embedding as number[]);
}

export async function embedOne(text: string): Promise<number[]> {
  const [vec] = await embed([text]);
  if (!vec) throw new Error('embedding failed');
  return vec;
}
