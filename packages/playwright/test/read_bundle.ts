import { gunzipSync } from 'node:zlib';

import { extract } from 'tar-stream';

export async function readBundle(
  compressed: Uint8Array,
): Promise<Map<string, Buffer>> {
  const tar = extract();
  tar.end(gunzipSync(compressed));
  const files = new Map<string, Buffer>();
  for await (const entry of tar) {
    const chunks: Buffer[] = [];
    for await (const chunk of entry) {
      chunks.push(chunk as Buffer);
    }
    files.set(entry.header.name, Buffer.concat(chunks));
  }
  return files;
}
