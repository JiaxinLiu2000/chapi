import fs from 'node:fs';
import * as lancedb from '@lancedb/lancedb';
import { config } from '../config.js';
import { createLogger } from '../logger.js';

const log = createLogger('rag:lance');
const TABLE = 'wiki_vectors';

export interface WikiVectorRow {
  id: string;
  entryId: string;
  chunk: string;
  sourceRef: string; // JSON string of WikiSourceRef | "null"
  vector: number[];
}

let dbPromise: Promise<lancedb.Connection> | null = null;
function db(): Promise<lancedb.Connection> {
  if (!dbPromise) {
    fs.mkdirSync(config.paths.lancedb, { recursive: true });
    dbPromise = lancedb.connect(config.paths.lancedb);
  }
  return dbPromise;
}

async function hasTable(conn: lancedb.Connection): Promise<boolean> {
  return (await conn.tableNames()).includes(TABLE);
}

/** Replace all vectors for an entry, then insert the new ones. */
export async function lanceUpsertEntry(entryId: string, rows: WikiVectorRow[]): Promise<void> {
  if (rows.length === 0) return;
  const conn = await db();
  const data = rows as unknown as Record<string, unknown>[];
  if (await hasTable(conn)) {
    const table = await conn.openTable(TABLE);
    await table.delete(`entryId = '${entryId.replace(/'/g, "''")}'`).catch(() => undefined);
    await table.add(data);
  } else {
    await conn.createTable(TABLE, data);
  }
  log.debug(`upserted ${rows.length} vectors for entry ${entryId}`);
}

export async function lanceDeleteEntry(entryId: string): Promise<void> {
  const conn = await db();
  if (!(await hasTable(conn))) return;
  const table = await conn.openTable(TABLE);
  await table.delete(`entryId = '${entryId.replace(/'/g, "''")}'`).catch(() => undefined);
}

export interface LanceHit {
  entryId: string;
  chunk: string;
  sourceRef: string;
  distance: number;
}

export async function lanceSearch(vector: number[], k: number): Promise<LanceHit[]> {
  const conn = await db();
  if (!(await hasTable(conn))) return [];
  const table = await conn.openTable(TABLE);
  const results = (await table.search(vector).limit(k).toArray()) as Array<
    Record<string, unknown>
  >;
  return results.map((r) => ({
    entryId: String(r.entryId ?? ''),
    chunk: String(r.chunk ?? ''),
    sourceRef: String(r.sourceRef ?? 'null'),
    distance: typeof r._distance === 'number' ? r._distance : 0,
  }));
}
