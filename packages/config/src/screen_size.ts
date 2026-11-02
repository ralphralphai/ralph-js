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
      'A rendered screen size: width x height in CSS pixels, such as the size a usage event was recorded at.',
  });

export const CaptureScreenSizeSchema = z
  .strictObject({
    ...ScreenSizeSchema.shape,
    minWidth: z
      .int()
      .nonnegative()
      .optional()
      .describe(
        'The narrowest viewport, in CSS pixels, whose sessions are analyzed against this capture. Absent means no lower bound.',
      ),
    maxWidth: z
      .int()
      .positive()
      .optional()
      .describe(
        'The widest viewport, in CSS pixels, whose sessions are analyzed against this capture. Absent means no upper bound.',
      ),
    device: z
      .enum(['mobile', 'desktop', 'tablet'])
      .optional()
      .describe(
        'The kind of device this capture stands for. Absent, it is guessed from `width`: below 640 is mobile, below 1024 tablet, and desktop otherwise.',
      ),
  })
  .meta({
    id: 'CaptureScreenSize',
    description:
      'A screen size to capture at, and which sessions are analyzed against it. Once any screen size declares `minWidth` or `maxWidth`, every one owns the band `[minWidth ?? 0, maxWidth ?? ∞]`, and no two bands may overlap. When none declares one, each owns the widths nearer to it than to any other.',
  });

type CaptureScreenSize = z.infer<typeof CaptureScreenSizeSchema>;

export const screenDeviceOf = (
  size: Pick<CaptureScreenSize, 'width' | 'device'>,
): NonNullable<CaptureScreenSize['device']> => {
  if (size.device !== undefined) {
    return size.device;
  }

  if (size.width < 640) {
    return 'mobile';
  }

  return size.width < 1024 ? 'tablet' : 'desktop';
};

const declaresBand = (size: CaptureScreenSize) => {
  return size.minWidth !== undefined || size.maxWidth !== undefined;
};

const label = (size: CaptureScreenSize) => {
  return `${size.width}x${size.height}`;
};

export const CaptureScreenSizesSchema = z
  .array(CaptureScreenSizeSchema)
  .superRefine((sizes, context) => {
    if (!sizes.some(declaresBand)) {
      return;
    }

    const bands = sizes.map((size) => {
      return {
        size,
        min: size.minWidth ?? 0,
        max: size.maxWidth ?? Number.POSITIVE_INFINITY,
      };
    });

    for (const [index, { size, min, max }] of bands.entries()) {
      if (min > max) {
        context.addIssue({
          code: 'custom',
          path: [index],
          message: `${label(size)}: minWidth ${min} exceeds maxWidth ${max}.`,
        });
        continue;
      }

      // Its sessions' clicks are drawn on its own screenshot, so a band that
      // excludes its width would draw them on a layout they never saw.
      if (size.width < min || size.width > max) {
        context.addIssue({
          code: 'custom',
          path: [index],
          message: `${label(size)}: its width is outside its own band [${min}, ${max}].`,
        });
      }
    }

    for (const [index, current] of bands.entries()) {
      for (const other of bands.slice(0, index)) {
        if (current.min <= other.max && other.min <= current.max) {
          context.addIssue({
            code: 'custom',
            path: [index],
            message: `${label(current.size)} overlaps ${label(other.size)}: a session's width has to pick one capture. A screen size without minWidth or maxWidth covers every width.`,
          });
        }
      }
    }
  });
