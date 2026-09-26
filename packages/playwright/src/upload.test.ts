import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { setImmediate } from 'node:timers/promises';

import { afterEach, expect, it, vi } from 'vitest';

import { readBundle } from '../test/read_bundle';
import type { RawGraphManifest } from './types';
import {
  createRawGraphBundle,
  prepareArtifactUpload,
  resolveUploadOptions,
  resultLink,
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
  vi.unstubAllGlobals();
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

it('requires credentials and an app id for upload, defaulting to the production API', () => {
  vi.stubEnv('RALPH_UPLOAD_KEY', undefined);
  vi.stubEnv('RALPH_API_URL', undefined);
  vi.stubEnv('RALPH_APP_ID', undefined);
  expect(() => resolveUploadOptions({})).toThrow('RALPH_UPLOAD_KEY');
  vi.stubEnv('RALPH_UPLOAD_KEY', 'secret');
  expect(() => resolveUploadOptions({})).toThrow('RALPH_APP_ID');
  vi.stubEnv('RALPH_APP_ID', 'app12345');
  expect(resolveUploadOptions({}).apiUrl).toBe('https://api.ralphralph.ai');
  vi.stubEnv('RALPH_API_URL', 'http://localhost:8080');
  expect(resolveUploadOptions({})).toMatchObject({
    uploadKey: 'secret',
    apiUrl: 'http://localhost:8080',
    appId: 'app12345',
  });
  expect(resolveUploadOptions({ appId: 'override' }).appId).toBe('override');
});

it("links to the server's result URL, else the Ralph dashboard", () => {
  const receipt = { artifactId: 'artifact-1' };
  expect(resultLink(receipt)).toBe(
    'https://dash.ralphralph.ai/uploads/artifact-1',
  );
  expect(
    resultLink({ ...receipt, resultUrl: 'https://dash.example/r/1' }),
  ).toBe('https://dash.example/r/1');
});

/** A stand-in Ralph server that records each request and answers with `reply`. */
async function startServer(
  reply: (url: string) => Record<string, unknown>,
): Promise<{
  requests: {
    url?: string;
    authorization?: string;
    contentType?: string;
    body: Buffer;
  }[];
  options: { apiUrl: string; appId: string; uploadKey: string };
  close: () => Promise<void>;
}> {
  const requests: {
    url?: string;
    authorization?: string;
    contentType?: string;
    body: Buffer;
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
      body: Buffer.concat(chunks),
    });
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify(reply(request.url ?? '')));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    requests,
    options: {
      apiUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      appId: 'app12345',
      uploadKey: 'secret',
    },
    close: async () => {
      server.close();
      await once(server, 'close');
    },
  };
}

it('prepares an artifact for the app and returns its result link', async () => {
  const server = await startServer(() => ({
    result: 'ok',
    artifactId: 'artifact-1',
    resultUrl: 'https://dash.example/uploads/artifact-1',
  }));
  try {
    expect(await prepareArtifactUpload(server.options)).toEqual({
      artifactId: 'artifact-1',
      resultUrl: 'https://dash.example/uploads/artifact-1',
    });
    expect(server.requests).toEqual([
      {
        url: '/api/upload/artifact/prepare',
        authorization: 'Bearer secret',
        contentType: 'application/json',
        body: Buffer.from(JSON.stringify({ externalAppId: 'app12345' })),
      },
    ]);
  } finally {
    await server.close();
  }
});

it('streams the bundle to the prepared artifact and verifies the server receipt', async () => {
  let uploads = 0;
  const server = await startServer(() => ({
    result: 'ok',
    status: 'queued',
    artifactId: manifest.artifactId,
    replayed: uploads++ > 0,
  }));
  try {
    vi.stubEnv('RALPH_UPLOAD_STORAGE', undefined);
    expect(await uploadRawGraph(manifest, [], server.options)).toEqual({
      result: 'ok',
      status: 'queued',
      artifactId: manifest.artifactId,
      replayed: false,
    });
    vi.stubEnv('RALPH_UPLOAD_STORAGE', 'gcs');
    expect((await uploadRawGraph(manifest, [], server.options)).replayed).toBe(
      true,
    );
    vi.stubEnv('RALPH_UPLOAD_STORAGE', 'local');
    await uploadRawGraph(manifest, [], server.options);
    vi.stubEnv('RALPH_UPLOAD_STORAGE', 'disk');
    await expect(uploadRawGraph(manifest, [], server.options)).rejects.toThrow(
      'gcs or local',
    );

    const path = `/api/upload/web/apps/app12345/artifact/${manifest.artifactId}`;
    expect(
      await Promise.all(
        server.requests.map(async ({ body, ...request }) => ({
          ...request,
          bundle: await readIndex(body),
        })),
      ),
    ).toEqual(
      [path, path, `${path}?storage=local`].map((url) => ({
        url,
        authorization: 'Bearer secret',
        contentType: 'application/gzip',
        bundle: { manifest, screenshots: [] },
      })),
    );
  } finally {
    await server.close();
  }
});

it.each([
  { result: 'ok' },
  { result: 'ok', artifactId: 7 },
  { result: 'ok', artifactId: 'a', resultUrl: 7 },
  { result: 'error', artifactId: 'a' },
])('reports an unreadable prepare reply (%j)', async (reply) => {
  const server = await startServer(() => reply);
  try {
    await expect(prepareArtifactUpload(server.options)).rejects.toThrow(
      "reply couldn't be read",
    );
  } finally {
    await server.close();
  }
});

it("shows Ralph's own reason for a rejected prepare", async () => {
  const server = createServer((_request, response) => {
    response.writeHead(401, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ result: 'unauthenticated' }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    await expect(
      prepareArtifactUpload({
        apiUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        appId: 'app12345',
        uploadKey: 'secret',
      }),
    ).rejects.toThrow(/RALPH_UPLOAD_KEY.*HTTP 401: unauthenticated/);
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
  ).rejects.toThrow('https://');
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
          status: 'queued',
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

it.each([
  [401, 'RALPH_UPLOAD_KEY'],
  [403, 'RALPH_APP_ID'],
  [404, 'RALPH_APP_ID'],
  [413, 'too big'],
  [503, 'Run again later'],
])('explains HTTP %s and how to fix it', async (status, fix) => {
  const server = createServer((_request, response) => {
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ message: 'server says no' }));
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
    ).rejects.toThrow(new RegExp(`${fix}.*HTTP ${status}: server says no`));
  } finally {
    server.closeAllConnections();
    server.close();
    await once(server, 'close');
  }
});

it('handles upload cancellation while screenshot entries are still queued', async () => {
  const failure = new TypeError('fetch failed');
  vi.stubGlobal('fetch', async (_url: URL, init: RequestInit) => {
    const reader = (init.body as ReadableStream<Uint8Array>).getReader();
    expect((await reader.read()).done).toBe(false);
    await reader.cancel(failure);
    throw failure;
  });

  await expect(
    uploadRawGraph(
      manifest,
      Array.from({ length: 8 }, () => ({
        nodeId: randomUUID(),
        contentType: 'image/png' as const,
        bytes: randomBytes(1024 * 1024),
      })),
      {
        apiUrl: 'https://ralph.example',
        appId: 'app12345',
        uploadKey: 'secret',
      },
    ),
  ).rejects.toThrow("Couldn't connect to Ralph");
  // Let stream destruction finish so unhandled entry errors fail the test run.
  await setImmediate();
});

it('explains an unreachable server', async () => {
  await expect(
    uploadRawGraph(manifest, [], {
      apiUrl: 'http://127.0.0.1:9',
      appId: 'app12345',
      uploadKey: 'secret',
    }),
  ).rejects.toThrow(
    /Couldn't connect to Ralph.*reach http:\/\/127\.0\.0\.1:9.*RALPH_API_URL/,
  );
});

it('explains a timeout', async () => {
  const server = createServer(() => {});
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    await expect(
      uploadRawGraph(manifest, [], {
        apiUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        appId: 'app12345',
        uploadKey: 'secret',
        timeoutMs: 50,
      }),
    ).rejects.toThrow(/longer than 0\.05s.*uploadTimeoutMs/);
  } finally {
    server.closeAllConnections();
    server.close();
    await once(server, 'close');
  }
});
