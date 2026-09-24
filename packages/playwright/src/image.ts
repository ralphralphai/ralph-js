import type { Page } from '@playwright/test';

/**
 * Matches the crawler's full-page screenshots: lossless measured larger than this
 * on real sites, which are mostly photographic content.
 */
const WEBP_QUALITY = 80;

export type Screenshot = {
  bytes: Buffer;
  contentType: 'image/webp' | 'image/png';
  width: number;
  height: number;
};

export async function takeScreenshot(
  page: Page,
  deadline: number,
): Promise<Screenshot> {
  const options = { fullPage: true, scale: 'css' } as const;
  const webp = await page.screenshot({
    ...options,
    type: 'webp',
    quality: WEBP_QUALITY,
    timeout: Math.max(1, deadline - Date.now()),
  });
  // WebP stores each dimension in 14 bits, so a page over 16383px has no valid
  // encoding. Chromium signals that with an empty buffer rather than an error;
  // PNG has no such limit.
  if (webp.length > 0) {
    return { bytes: webp, contentType: 'image/webp', ...webpSize(webp) };
  }
  const png = await page.screenshot({
    ...options,
    type: 'png',
    timeout: Math.max(1, deadline - Date.now()),
  });
  return {
    bytes: png,
    contentType: 'image/png',
    width: png.readUInt32BE(16),
    height: png.readUInt32BE(20),
  };
}

export function imageExtension(contentType: Screenshot['contentType']): string {
  return contentType === 'image/png' ? '.png' : '.webp';
}

function webpSize(bytes: Buffer): { width: number; height: number } {
  if (
    bytes.toString('ascii', 0, 4) !== 'RIFF' ||
    bytes.toString('ascii', 8, 12) !== 'WEBP'
  ) {
    throw new Error('The screenshot is not a WebP image.');
  }
  const chunk = bytes.toString('ascii', 12, 16);
  if (chunk === 'VP8X') {
    return {
      width: 1 + bytes.readUIntLE(24, 3),
      height: 1 + bytes.readUIntLE(27, 3),
    };
  }
  if (chunk === 'VP8 ') {
    return {
      width: bytes.readUInt16LE(26) & 0x3fff,
      height: bytes.readUInt16LE(28) & 0x3fff,
    };
  }
  if (chunk === 'VP8L') {
    const bits = bytes.readUInt32LE(21);
    return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >> 14) & 0x3fff) };
  }
  throw new Error('Unsupported WebP chunk: ' + chunk);
}
