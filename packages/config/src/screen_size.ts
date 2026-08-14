import { z } from 'zod';

// The `id` is what names the type generated from this schema, and the `$defs`
// entry it is generated from. Deliberately no `title`: the type generator
// prefers a title over the id, and would mangle a prose one.
export const ScreenSizeSchema = z
  .object({
    width: z.number().describe('Viewport width in CSS pixels.'),
    height: z.number().describe('Viewport height in CSS pixels.'),
  })
  .meta({
    id: 'ScreenSize',
    description:
      'A rendered screen size: width x height in CSS pixels. Used both for the crawl capture sizes and for the size a usage event was recorded at.',
  });
