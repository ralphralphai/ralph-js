import { type EventBatch, gzipBatch } from '@ralphralphai/schema';

import type { SendBatch } from '@/tracker';

/**
 * The largest body sent uncompressed with `keepalive`. Browsers cap the bodies
 * of all in-flight `keepalive` requests at 64 KiB in total, so this leaves room
 * for a periodic flush still in flight.
 */
const MAX_PLAIN_KEEPALIVE_BYTES = 48 * 1024;

export type IngestTransportConfig = {
  /** Base URL of the Ralph API, e.g. `https://ingest.example.com`. */
  endpoint: string;
  /** Project key. Sent as a bearer token; the server derives the project from it. */
  apiKey: string;
};

/**
 * The default transport: gzip the batch and POST it.
 *
 * Separate from [`Tracker`] because the transport is dependency-injected: a
 * consumer that already has an authenticated client, a queue, or a proxy route
 * supplies its own.
 */
export const createIngestTransport = ({
  endpoint,
  apiKey,
}: IngestTransportConfig): SendBatch => {
  const url = `${endpoint.replace(/\/+$/, '')}/v1/ingest`;

  return async (batch: EventBatch, { keepalive }) => {
    // A `keepalive` flush runs as the page is hidden or closed. Compression is
    // async, and a closing page can be torn down before it finishes, so the
    // request would never start. Plain JSON lets `fetch` start synchronously.
    const plain = keepalive ? plainBody(batch) : null;
    const body = plain ?? (await gzipBatch(batch));

    try {
      await fetch(url, {
        method: 'POST',
        keepalive,
        headers: {
          authorization: `Bearer ${apiKey}`,
          'content-type': 'application/json',
          ...(plain ? {} : { 'content-encoding': 'gzip' }),
        },
        body: body as BodyInit,
      });
    } catch {
      // Delivery is best effort. The wire format carries no client batch id and
      // the server does not deduplicate retries, so the transport drops a failed
      // flush rather than retrying it: a gap is acceptable for aggregate
      // analytics, and a retry would risk double-counting instead.
    }
  };
};

/** `null` when the batch is too large to send uncompressed with `keepalive`. */
const plainBody = (batch: EventBatch): Uint8Array | null => {
  const body = new TextEncoder().encode(JSON.stringify(batch));
  return body.byteLength <= MAX_PLAIN_KEEPALIVE_BYTES ? body : null;
};

/** Serialize a batch the way the transport would, without sending it. */
export const encodeForTransport = (batch: EventBatch): Promise<Uint8Array> =>
  gzipBatch(batch);
