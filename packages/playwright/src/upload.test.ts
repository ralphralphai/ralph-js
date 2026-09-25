import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, expect, it, vi } from 'vitest';

import { readBundle } from '../test/read_bundle';
import type { RawGraphManifest } from './types';
import {
  createRawGraphBundle,
  resolveUploadOptions,
  uploadRawGraph,
} from './upload';

const manifest: RawGraphManifest = {
  formatVersion: 1,
  producer: {
    name: '@ralphralphai/playwright',
    version: '0.1.0',
    playwrightVersion: '1.62.1',
  },
  artifactId: randomUUID(),
  shard: null,
  startedAt: '2026-09-23T12:00:00.000Z',
  finishedAt: '2026-09-23T12:00:00.000Z',
  config: {
    config: { screenSizes: [] },
    packageVersion: '2.0.0',
  },
  rawGraphs: [],
  complete: false,
};

async function readIndex(compressed: Uint8Array): Promise<unknown> {
  const files = await readBundle(compressed);
  return JSON.parse(Buffer.from(files.get('raw_graph.json')!).toString());
}

afterEach(() => {
  vi.unstubAllEnvs();
});

it('encodes a gzipped tar with a JSON index referencing image files', async () => {
  const nodeId = randomUUID();
  const bytes = Buffer.from([0, 1, 2, 253, 254, 255]);
  const fallbackId = randomUUID();
  const compressed = await createRawGraphBundle(manifest, [
    { nodeId, contentType: 'image/webp', bytes },
    { nodeId: fallbackId, contentType: 'image/png', bytes },
  ]);
  expect(Buffer.from(compressed.subarray(0, 2)).toString('hex')).toBe('1f8b');
  const path = `assets/images/${nodeId}.webp`;
  const fallbackPath = `assets/images/${fallbackId}.png`;
  const files = await readBundle(compressed);
  expect([...files.keys()]).toEqual(['raw_graph.json', path, fallbackPath]);
  expect(
    JSON.parse(Buffer.from(files.get('raw_graph.json')!).toString()),
  ).toEqual({
    manifest,
    screenshots: [
      { nodeId, path },
      { nodeId: fallbackId, path: fallbackPath },
    ],
  });
  expect(Buffer.from(files.get(path)!)).toEqual(bytes);
});

it('rejects node ids that are not path-safe', async () => {
  await expect(
    createRawGraphBundle(manifest, [
      {
        nodeId: '../escape',
        contentType: 'image/webp',
        bytes: new Uint8Array(),
      },
    ]),
  ).rejects.toThrow('path-safe');
});

it('requires credentials, an app id, and an explicit API origin for upload', () => {
  vi.stubEnv('RALPH_UPLOAD_KEY', undefined);
  vi.stubEnv('RALPH_API_URL', undefined);
  vi.stubEnv('RALPH_APP_ID', undefined);
  expect(() => resolveUploadOptions({})).toThrow('RALPH_UPLOAD_KEY');
  vi.stubEnv('RALPH_UPLOAD_KEY', 'secret');
  vi.stubEnv('RALPH_API_URL', 'http://localhost:8080');
  expect(() => resolveUploadOptions({})).toThrow('RALPH_APP_ID');
  vi.stubEnv('RALPH_APP_ID', 'app12345');
  expect(resolveUploadOptions({})).toMatchObject({
    uploadKey: 'secret',
    apiUrl: 'http://localhost:8080',
    appId: 'app12345',
  });
  expect(resolveUploadOptions({ appId: 'override' }).appId).toBe('override');
});

it('uploads with bearer authentication and verifies the server receipt', async () => {
  const requests: {
    url?: string;
    authorization?: string;
    contentType?: string;
    bundle: unknown;
  }[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      chunks.push(Buffer.from(chunk));
    }
    requests.push({
      url: request.url,
      authorization: request.headers.authorization,
      contentType: request.headers['content-type'],
      bundle: await readIndex(Buffer.concat(chunks)),
    });
    response.setHeader('content-type', 'application/json');
    response.end(
      JSON.stringify({
        result: 'ok',
        status: 'received',
        artifactId: manifest.artifactId,
        resultId: 'result-1',
        replayed: requests.length > 1,
      }),
    );
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const options = {
      apiUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      appId: 'app12345',
      uploadKey: 'secret',
    };
    vi.stubEnv('RALPH_UPLOAD_STORAGE', undefined);
    expect((await uploadRawGraph(manifest, [], options)).replayed).toBe(false);
    vi.stubEnv('RALPH_UPLOAD_STORAGE', 'gcs');
    expect((await uploadRawGraph(manifest, [], options)).replayed).toBe(true);
    vi.stubEnv('RALPH_UPLOAD_STORAGE', 'local');
    await uploadRawGraph(manifest, [], options);
    vi.stubEnv('RALPH_UPLOAD_STORAGE', 'disk');
    await expect(uploadRawGraph(manifest, [], options)).rejects.toThrow(
      'gcs or local',
    );
    expect(requests).toEqual([
      ...Array(2).fill({
        url: '/api/upload/playwright/apps/app12345/artifact',
        authorization: 'Bearer secret',
        contentType: 'application/gzip',
        bundle: { manifest, screenshots: [] },
      }),
      {
        url: '/api/upload/playwright/apps/app12345/artifact?storage=local',
        authorization: 'Bearer secret',
        contentType: 'application/gzip',
        bundle: { manifest, screenshots: [] },
      },
    ]);
  } finally {
    server.close();
    await once(server, 'close');
  }
});

it.each([
  'http://example.com',
  'http://127.0.0.1.example.com',
  'http://localhost.example.com',
  'ftp://127.0.0.1',
])('rejects non-HTTPS API URLs outside loopback (%s)', async (apiUrl) => {
  await expect(
    uploadRawGraph(manifest, [], {
      apiUrl,
      appId: 'app12345',
      uploadKey: 'secret',
    }),
  ).rejects.toThrow('HTTPS');
});

it.each(['', '../escape', 'app/1', 'app?x=1'])(
  'rejects app ids that are not path-safe (%s)',
  async (appId) => {
    await expect(
      uploadRawGraph(manifest, [], {
        apiUrl: 'https://ralph.example',
        appId,
        uploadKey: 'secret',
      }),
    ).rejects.toThrow('app id');
  },
);

it.each([401, 409, 500, 302, 200])(
  'reports rejection or an invalid receipt (%s)',
  async (status) => {
    const server = createServer((_request, response) => {
      response.writeHead(status, {
        'content-type': 'application/json',
        location: 'http://localhost:1/elsewhere',
      });
      response.end(
        JSON.stringify({
          result: 'ok',
          status: 'received',
          artifactId: 'wrong',
          replayed: false,
        }),
      );
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    try {
      await expect(
        uploadRawGraph(manifest, [], {
          apiUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
          appId: 'app12345',
          uploadKey: 'secret',
        }),
      ).rejects.toThrow();
    } finally {
      server.closeAllConnections();
      server.close();
      await once(server, 'close');
    }
  },
);
