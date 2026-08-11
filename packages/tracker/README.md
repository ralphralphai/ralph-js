# @ralphralphai/tracker

The browser SDK for [Ralph](https://ralphralph.ai). It records clicks on
tagged elements, page views and pointer position, buffers them, and streams them to the
ingest API as gzipped columnar batches, roughly 8 bytes per event on the wire.

No runtime dependencies. React is a peer.

```bash
pnpm add @ralphralphai/tracker
```

## Mount it once

`GlobalTracker` uses hooks, so it ships from a separate `./client` entry point behind a
client boundary. That keeps `TrackedButton` and the attribute constants importable from a
Server Component without dragging a client boundary along.

```tsx
import { GlobalTracker } from '@ralphralphai/tracker/client';
import { createIngestTransport } from '@ralphralphai/tracker';

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html>
      <body>
        <GlobalTracker
          buildId={process.env.NEXT_PUBLIC_BUILD_ID}
          sendBatch={createIngestTransport({
            endpoint: 'https://ingest.example.com',
            apiKey: process.env.NEXT_PUBLIC_RALPH_KEY!,
          })}
        />
        {children}
      </body>
    </html>
  );
}
```

`buildId` identifies the deploy the events were recorded against. It is what lines a
recorded session up with the navigation graph a crawl produced for the same build.

## Tag what you want measured

```tsx
import { TrackedButton } from '@ralphralphai/tracker';

<TrackedButton trackId="signup-cta" crawlFollow>
  Get started
</TrackedButton>;
```

`trackId` emits `data-track-id`, which makes the element's clicks reportable. Adding
`crawlFollow` also emits `data-follow-id`, which tells the crawler to click this element
and explore what lies beyond it. A `data-track-id` on its own is measured but never
crawled.

## The transport is injected

`sendBatch` is a plain function, so an app that already has an authenticated client, a
queue, or a proxy route supplies its own instead of `createIngestTransport`:

```ts
import { encodeForTransport, type SendBatch } from '@ralphralphai/tracker';

const sendBatch: SendBatch = async (batch, { keepalive }) => {
  await fetch('/api/ralph', {
    method: 'POST',
    body: await encodeForTransport(batch),
    keepalive,
  });
};
```

Delivery is best effort by design. The wire format carries no client batch id and the
server does not deduplicate, so the tracker drops a failed flush rather than retrying it.
A retry would risk double-counting, which is worse than a gap for aggregate analytics.

## Where tracking silently does nothing

The tracker needs `localStorage` and `sessionStorage` for its anonymous user and session
ids. Where those throw (Safari in Lockdown Mode, some private-mode quota errors) it
disables itself rather than crashing your app. Server-side rendering is a no-op for the
same reason.

## License

Apache-2.0
