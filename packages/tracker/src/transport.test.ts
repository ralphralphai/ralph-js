import { encodeBatch } from '@ralphralphai/schema';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createIngestTransport } from '@/transport';

const batch = encodeBatch(
  {
    userId: '00000000-0000-4000-8000-000000000000',
    sessionId: '00000000-0000-4000-8000-000000000001',
  },
  [{ ty: 6, at: 1_000 }],
);

const send = createIngestTransport({
  endpoint: 'https://ingest.example.com/',
  apiKey: 'key',
});

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn(async () => {
    return new Response(null);
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const sentInit = (): RequestInit => {
  return fetchMock.mock.calls[0]![1] as RequestInit;
};

describe('ingest transport', () => {
  it('starts a keepalive request synchronously, as plain JSON', () => {
    void send(batch, { keepalive: true });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sentInit().keepalive).toBe(true);
    expect(sentInit().headers).not.toHaveProperty('content-encoding');
    const body = new TextDecoder().decode(sentInit().body as Uint8Array);
    expect(JSON.parse(body)).toEqual(batch);
  });

  it('gzips everything else', async () => {
    await send(batch, { keepalive: false });

    expect(fetchMock.mock.calls[0]![0]).toBe(
      'https://ingest.example.com/v1/ingest',
    );
    expect(sentInit().headers).toHaveProperty('content-encoding', 'gzip');
  });
});
