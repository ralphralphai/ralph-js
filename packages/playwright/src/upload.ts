import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';

import { pack } from 'tar-stream';

import { imageExtension, type Screenshot } from './image';
import type { RawGraphManifest } from './types';

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
/** An artifact the server reserved, which the upload and the manifest must name. */
export type PreparedUpload = {
  artifactId: string;
  /** Where the result opens in the Ralph dashboard, when the server knows. */
  resultUrl?: string;
};
/** The bundle is stored and queued; the result page shows it being processed. */
export type UploadReceipt = {
  result: 'ok';
  status: 'queued';
  artifactId: string;
  resultUrl?: string;
  replayed: boolean;
};

export const DEFAULT_API_URL = 'https://api.ralphralph.ai';
export const DASHBOARD_URL = 'https://dash.ralphralph.ai';

/** Where the uploaded run opens: the server's link, else the Ralph dashboard. */
export function resultLink({
  artifactId,
  resultUrl,
}: {
  artifactId: string;
  resultUrl?: string;
}): string {
  return (
    resultUrl ?? `${DASHBOARD_URL}/uploads/${encodeURIComponent(artifactId)}`
  );
}

/** Where the reporter uploads: its options, else the environment, else Ralph's production server. */
export function resolveUploadOptions(options: {
  apiUrl?: string;
  appId?: string;
  uploadTimeoutMs?: number;
}): UploadOptions {
  const uploadKey = process.env['RALPH_UPLOAD_KEY'];
  const apiUrl =
    options.apiUrl || process.env['RALPH_API_URL'] || DEFAULT_API_URL;
  const appId = options.appId ?? process.env['RALPH_APP_ID'];
  if (!uploadKey) {
    throw new Error(
      `To upload to Ralph, set RALPH_UPLOAD_KEY. ${CREATE_KEY_HINT}`,
    );
  }
  if (!appId) {
    throw new Error(
      'To upload to Ralph, set RALPH_APP_ID (or the reporter option appId) to the app the recordings belong to.',
    );
  }
  return { uploadKey, apiUrl, appId, timeoutMs: options.uploadTimeoutMs };
}

// Mirrors the server's limits, so an oversized run fails before it is sent.
export const MAX_MANIFEST_BYTES = 16 * 1024 * 1024;
export const MAX_SCREENSHOTS = 5000;
export const MAX_SCREENSHOT_BYTES = 256 * 1024 * 1024;
export const MAX_COMPRESSED_BYTES = 256 * 1024 * 1024;

export const RAW_GRAPH_BUNDLE_INDEX = 'raw_graph.json';
export const RAW_GRAPH_BUNDLE_IMAGE_DIR = 'assets/images';

export type RawGraphBundleIndex = {
  manifest: RawGraphManifest;
  screenshots: { nodeId: string; path: string }[];
};

/** Where a node's screenshot sits inside the bundle. */
export function bundleImagePath(
  nodeId: string,
  contentType: Screenshot['contentType'],
): string {
  if (!/^[A-Za-z0-9-]{1,64}$/.test(nodeId)) {
    throw new Error(`Ralph node id is not path-safe: ${nodeId}`);
  }
  return `${RAW_GRAPH_BUNDLE_IMAGE_DIR}/${nodeId}${imageExtension(contentType)}`;
}

const TOO_BIG =
  'This run is too big to upload to Ralph. Record fewer pages or screen sizes, or split the tests across runs.';

class TooBigError extends Error {
  constructor() {
    super(TOO_BIG);
  }
}

/**
 * Packs the manifest and screenshots into a gzipped tar archive, produced as it
 * is read so the compressed bundle is never held whole:
 *
 *   raw_graph.json               { manifest, screenshots: [{ nodeId, path }] }
 *   assets/images/<id>.webp    raw screenshot bytes (.png when too large for WebP)
 *
 * Fails with a `TooBigError` once the compressed bytes pass the limit.
 */
function rawGraphBundleStream(
  manifest: RawGraphManifest,
  screenshots: readonly RawGraphScreenshot[],
): Readable {
  if (
    Buffer.byteLength(JSON.stringify(manifest)) > MAX_MANIFEST_BYTES ||
    screenshots.length > MAX_SCREENSHOTS ||
    screenshots.reduce(
      (total, screenshot) => total + screenshot.bytes.byteLength,
      0,
    ) > MAX_SCREENSHOT_BYTES
  ) {
    throw new TooBigError();
  }

  const images = screenshots.map(({ nodeId, contentType, bytes }) => ({
    nodeId,
    path: bundleImagePath(nodeId, contentType),
    bytes,
  }));
  const index: RawGraphBundleIndex = {
    manifest,
    screenshots: images.map(({ nodeId, path }) => ({ nodeId, path })),
  };

  // Fixed attributes keep retries of the same artifact byte-identical.
  const attrs = { mtime: new Date(0), uid: 0, gid: 0 };
  const tar = pack();

  // Cancellation destroys queued entries too; handle their errors through the
  // pack's pipeline instead of leaving unhandled stream error events.
  const onEntryError = (error: Error) => tar.destroy(error);
  tar
    .entry({ name: RAW_GRAPH_BUNDLE_INDEX, ...attrs }, JSON.stringify(index))
    .on('error', onEntryError);

  for (const { path, bytes } of images) {
    tar
      .entry({ name: path, ...attrs }, Buffer.from(bytes))
      .on('error', onEntryError);
  }
  tar.finalize();

  const gzip = createGzip();
  pipeline(tar, gzip).catch((error: unknown) => gzip.destroy(error as Error));
  return Readable.from(
    (async function* () {
      let size = 0;
      for await (const chunk of gzip) {
        size += (chunk as Buffer).byteLength;
        if (size > MAX_COMPRESSED_BYTES) {
          throw new TooBigError();
        }
        yield chunk as Buffer;
      }
    })(),
  );
}

/** The bundle `uploadRawGraph` streams, whole, for saving or inspecting it. */
export async function createRawGraphBundle(
  manifest: RawGraphManifest,
  screenshots: readonly RawGraphScreenshot[],
): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  for await (const chunk of rawGraphBundleStream(manifest, screenshots)) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

function isLoopback(url: URL): boolean {
  return (
    url.hostname === 'localhost' ||
    url.hostname === '[::1]' ||
    /^127(\.\d{1,3}){3}$/.test(url.hostname)
  );
}

function checkedApiUrl(options: UploadOptions, path: string): URL {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(options.appId)) {
    throw new Error(
      `"${options.appId}" isn't a valid Ralph app id. Check RALPH_APP_ID.`,
    );
  }
  const url = new URL(path, options.apiUrl);
  if (
    !(
      url.protocol === 'https:' ||
      (url.protocol === 'http:' && isLoopback(url))
    )
  ) {
    throw new Error(
      `RALPH_API_URL must start with https:// (http:// only works for localhost), not ${options.apiUrl}.`,
    );
  }
  if (!options.uploadKey) {
    throw new Error(
      `To upload to Ralph, set RALPH_UPLOAD_KEY. ${CREATE_KEY_HINT}`,
    );
  }
  return url;
}

/** Sends one request, turning every way it can fail into a message that says what to fix. */
async function request(
  url: URL,
  init: RequestInit & { duplex?: 'half' },
  options: UploadOptions,
  timeoutMs: number,
): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      method: 'POST',
      headers: {
        ...init.headers,
        Authorization: `Bearer ${options.uploadKey}`,
      },
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    if (
      error instanceof TooBigError ||
      (error instanceof Error && error.cause instanceof TooBigError)
    ) {
      throw new Error(TOO_BIG, { cause: error });
    }
    throw new Error(describeRequestFailure(error, url, timeoutMs), {
      cause: error,
    });
  }

  if (!response.ok) {
    throw new Error(
      describeHttpFailure(
        response.status,
        await responseDetail(response),
        url,
        options.appId,
      ),
    );
  }

  try {
    return (await response.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}

const unreadableReply = (url: URL) =>
  new Error(
    "Upload to Ralph failed. Ralph's reply couldn't be read. Update @ralphralphai/playwright to the latest version and run again." +
      customServerHint(url),
  );

const PREPARE_TIMEOUT_MS = 30_000;

/**
 * Reserves an artifact for the run. Its `resultUrl` works from now on, so the
 * run can be followed while it uploads and while Ralph processes it.
 */
export async function prepareArtifactUpload(
  options: UploadOptions,
): Promise<PreparedUpload> {
  const url = checkedApiUrl(options, '/api/upload/artifact/prepare');
  const reply = await request(
    url,
    {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ externalAppId: options.appId }),
    },
    options,
    PREPARE_TIMEOUT_MS,
  );
  if (
    reply['result'] !== 'ok' ||
    typeof reply['artifactId'] !== 'string' ||
    (reply['resultUrl'] !== undefined && typeof reply['resultUrl'] !== 'string')
  ) {
    throw unreadableReply(url);
  }
  return {
    artifactId: reply['artifactId'],
    resultUrl: reply['resultUrl'] as string | undefined,
  };
}

/**
 * Streams the run's bundle to the artifact `manifest.artifactId` names, which
 * `prepareArtifactUpload` has to have reserved. Ralph processes it after this
 * returns; the result page shows when it is ready.
 */
export async function uploadRawGraph(
  manifest: RawGraphManifest,
  screenshots: readonly RawGraphScreenshot[],
  options: UploadOptions,
): Promise<UploadReceipt> {
  const url = checkedApiUrl(
    options,
    `/api/upload/web/apps/${options.appId}/artifact/${encodeURIComponent(manifest.artifactId)}`,
  );
  // Environment only, and absent from the public options, because only Ralph
  // developers run a server that accepts local storage.
  const storage = process.env['RALPH_UPLOAD_STORAGE'] || 'gcs';
  if (storage !== 'gcs' && storage !== 'local') {
    throw new Error(
      `RALPH_UPLOAD_STORAGE must be gcs or local, not ${storage}.`,
    );
  }
  if (storage === 'local') {
    url.searchParams.set('storage', 'local');
  }

  const timeoutMs = options.timeoutMs ?? 120_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error(
      'uploadTimeoutMs in the Ralph reporter options must be a positive number of milliseconds.',
    );
  }

  const receipt = await request(
    url,
    {
      headers: { 'content-type': 'application/gzip' },
      body: Readable.toWeb(
        rawGraphBundleStream(manifest, screenshots),
      ) as ReadableStream,
      // Required by fetch for a streamed body.
      duplex: 'half',
    },
    options,
    timeoutMs,
  );
  if (
    receipt['result'] !== 'ok' ||
    receipt['status'] !== 'queued' ||
    receipt['artifactId'] !== manifest.artifactId ||
    (receipt['resultUrl'] !== undefined &&
      typeof receipt['resultUrl'] !== 'string') ||
    typeof receipt['replayed'] !== 'boolean'
  ) {
    throw unreadableReply(url);
  }
  return receipt as UploadReceipt;
}

const CREATE_KEY_HINT =
  'You can create an upload key in your project dashboard on Ralph.';
const SUPPORT_HINT = 'If it keeps failing, contact Ralph support.';

/** Only users who set their own server need to hear about it. */
function customServerHint(url: URL): string {
  return url.origin === new URL(DEFAULT_API_URL).origin
    ? ''
    : ` Also check RALPH_API_URL (${url.origin}) is right.`;
}

function describeRequestFailure(
  error: unknown,
  url: URL,
  timeoutMs: number,
): string {
  if (error instanceof Error && error.name === 'TimeoutError') {
    return (
      `Upload to Ralph took longer than ${timeoutMs / 1000}s and was stopped. ` +
      'Check your network, or raise uploadTimeoutMs in the reporter options.'
    );
  }
  const cause =
    error instanceof Error && error.cause instanceof Error
      ? error.cause.message
      : error instanceof Error
        ? error.message
        : String(error);
  return (
    `Couldn't connect to Ralph (${cause}). ` +
    `Check that this machine can reach ${url.origin}.` +
    customServerHint(url)
  );
}

function describeHttpFailure(
  status: number,
  detail: string | undefined,
  url: URL,
  appId: string,
): string {
  let message: string;
  if (status === 401) {
    message = `Ralph didn't accept your upload key. Check RALPH_UPLOAD_KEY. ${CREATE_KEY_HINT}`;
  } else if (status === 403) {
    message = `Your upload key can't upload to the app "${appId}". Check RALPH_APP_ID is an app in the same project as the key.`;
  } else if (status === 404) {
    message =
      `Ralph couldn't find the app "${appId}". Check RALPH_APP_ID.` +
      customServerHint(url);
  } else if (status === 413) {
    message =
      'This run is too big to upload. Record fewer pages or screen sizes, or split the tests across runs.';
  } else if (status === 429) {
    message = 'Too many uploads right now. Wait a minute and run again.';
  } else if (status >= 500) {
    message = `Something went wrong on Ralph's side. Run again later. ${SUPPORT_HINT}`;
  } else {
    message = `Ralph couldn't accept this upload. Update @ralphralphai/playwright to the latest version and run again. ${SUPPORT_HINT}`;
  }
  return `Upload to Ralph failed. ${message} (HTTP ${status}${detail ? `: ${detail}` : ''})`;
}

/** The server's reason for rejecting the upload, kept short. */
async function responseDetail(response: Response): Promise<string | undefined> {
  let text: string;
  try {
    text = (await response.text()).trim();
  } catch {
    return undefined;
  }
  try {
    const body = JSON.parse(text) as {
      result?: unknown;
      message?: unknown;
      error?: unknown;
    };
    const message = body.result ?? body.message ?? body.error;
    if (typeof message === 'string') {
      text = message;
    }
  } catch {
    // Not JSON; use the text as is.
  }
  text = text.replace(/\s+/g, ' ');
  return text.length > 200 ? text.slice(0, 200) + '…' : text || undefined;
}
