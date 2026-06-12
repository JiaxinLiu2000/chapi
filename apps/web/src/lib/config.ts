const RAW = process.env.NEXT_PUBLIC_SERVER_URL ?? 'http://127.0.0.1:8123';

export const SERVER_URL = RAW.replace(/\/$/, '');
export const API_BASE = `${SERVER_URL}/api`;
export const WS_URL = `${SERVER_URL.replace(/^http/, 'ws')}/ws`;
