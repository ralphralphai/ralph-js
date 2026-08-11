import { type EventBatch, gzipBatch } from '@ralphralphai/schema';

import type { SendBatch } from '@/tracker';

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
    const body = await gzipBatch(batch);

    try {
      await fetch(url, {
        method: 'POST',
        keepalive,
        headers: {
          authorization: `Bearer ${apiKey}`,
          'content-type': 'application/json',
          'content-encoding': 'gzip',
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

/** Serialize a batch the way the transport would, without sending it. */
export const encodeForTransport = (batch: EventBatch): Promise<Uint8Array> =>
  gzipBatch(batch);
