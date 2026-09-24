import { promisify } from 'node:util';
import { gzip } from 'node:zlib';

import { pack } from 'tar-stream';

import { imageExtension, type Screenshot } from './image';
import type { RawGraphManifest, RalphOptions } from './types';

export type UploadOptions = {
  apiUrl: string;
  appId: string;
  uploadKey: string;
  timeoutMs?: number;
};
export type RawGraphScreenshot = {
  nodeId: string;
  contentType: Screenshot['contentType'];
  bytes: Uint8Array;
};
export type UploadReceipt = {
  result: 'ok';
  status: 'received';
  attemptId: string;
  resultId: string;
  replayed: boolean;
};

export function resolveUploadOptions(options: RalphOptions): UploadOptions {
  const uploadKey = process.env['RALPH_UPLOAD_KEY'];
  const apiUrl = options.apiUrl ?? process.env['RALPH_API_URL'];
  const appId = options.appId ?? process.env['RALPH_APP_ID'];
  if (!uploadKey || !apiUrl || !appId) {
    throw new Error(
      'Ralph upload requires RALPH_UPLOAD_KEY, RALPH_API_URL (or ralphOptions.apiUrl), and RALPH_APP_ID (or ralphOptions.appId).',
    );
  }
  return { uploadKey, apiUrl, appId, timeoutMs: options.uploadTimeoutMs };
}

export const RAW_GRAPH_BUNDLE_INDEX = 'raw_graph.json';
export const RAW_GRAPH_BUNDLE_IMAGE_DIR = 'assets/images';

export type RawGraphBundleIndex = {
  manifest: RawGraphManifest;
  screenshots: { nodeId: string; path: string }[];
};

/**
 * Packs the manifest and screenshots into a gzipped tar archive:
 *
 *   raw_graph.json               { manifest, screenshots: [{ nodeId, path }] }
 *   assets/images/<id>.webp    raw screenshot bytes (.png when too large for WebP)
 */
export async function createRawGraphBundle(
  manifest: RawGraphManifest,
  screenshots: readonly RawGraphScreenshot[],
): Promise<Uint8Array> {
  if (
    Buffer.byteLength(JSON.stringify(manifest)) > 2 * 1024 * 1024 ||
    screenshots.length > 500 ||
    screenshots.reduce(
      (total, screenshot) => total + screenshot.bytes.byteLength,
      0,
    ) >
      64 * 1024 * 1024
  ) {
    throw new Error('Ralph raw graph exceeds upload limits.');
  }

  const images = screenshots.map(({ nodeId, contentType, bytes }) => {
    if (!/^[A-Za-z0-9-]{1,64}$/.test(nodeId)) {
      throw new Error(`Ralph node id is not path-safe: ${nodeId}`);
    }
    return {
      nodeId,
      path: `${RAW_GRAPH_BUNDLE_IMAGE_DIR}/${nodeId}${imageExtension(contentType)}`,
      bytes,
    };
  });
  const index: RawGraphBundleIndex = {
    manifest,
    screenshots: images.map(({ nodeId, path }) => ({ nodeId, path })),
  };

  // Fixed attributes keep retries of the same attempt byte-identical.
  const attrs = { mtime: new Date(0), uid: 0, gid: 0 };
  const tar = pack();
  tar.entry({ name: RAW_GRAPH_BUNDLE_INDEX, ...attrs }, JSON.stringify(index));
  for (const { path, bytes } of images) {
    tar.entry({ name: path, ...attrs }, Buffer.from(bytes));
  }
  tar.finalize();
  const chunks: Buffer[] = [];
  for await (const chunk of tar) {
    chunks.push(chunk as Buffer);
  }
  const compressed = await promisify(gzip)(Buffer.concat(chunks));
  if (compressed.byteLength > 64 * 1024 * 1024) {
    throw new Error('Ralph compressed raw graph bundle exceeds upload limits.');
  }

  return compressed;
}

function isLoopback(url: URL): boolean {
  return (
    url.hostname === 'localhost' ||
    url.hostname === '[::1]' ||
    /^127(\.\d{1,3}){3}$/.test(url.hostname)
  );
}

export async function uploadRawGraph(
  manifest: RawGraphManifest,
  screenshots: readonly RawGraphScreenshot[],
  options: UploadOptions,
): Promise<UploadReceipt> {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(options.appId)) {
    throw new Error(`Ralph app id is not valid: ${options.appId}`);
  }
  const url = new URL(
    `/api/upload/playwright/apps/${options.appId}/attempts`,
    options.apiUrl,
  );
  if (
    !(
      url.protocol === 'https:' ||
      (url.protocol === 'http:' && isLoopback(url))
    ) ||
    !options.uploadKey
  ) {
    throw new Error(
      'Ralph upload requires an HTTPS API URL (HTTP only for loopback hosts) and an upload key.',
    );
  }

  const timeoutMs = options.timeoutMs ?? 30_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error('Ralph uploadTimeoutMs must be positive and finite.');
  }

  const blob = new Blob(
    [new Uint8Array(await createRawGraphBundle(manifest, screenshots))],
    { type: 'application/gzip' },
  );

  const response = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${options.uploadKey}` },
    body: blob,
    redirect: 'error',
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!response.ok) {
    throw new Error(
      `Ralph upload failed (HTTP ${response.status}). Local Ralph artifacts are retained for retry.`,
    );
  }

  const receipt = (await response.json()) as Partial<UploadReceipt>;
  if (
    receipt.result !== 'ok' ||
    receipt.status !== 'received' ||
    receipt.attemptId !== manifest.attemptId ||
    typeof receipt.resultId !== 'string' ||
    typeof receipt.replayed !== 'boolean'
  ) {
    throw new Error('Ralph server returned an invalid upload receipt.');
  }
  return receipt as UploadReceipt;
}
