import type { ComponentPropsWithoutRef } from 'react';
import type React from 'react';

// The DOM attribute the crawler and the runtime tracker both key off of. A
// button/anchor tagged with it becomes a node edge in the navigation graph and
// its clicks are reported as `Pressable` usage, with `tr` the batch's index for
// `trackId`.
export const BUTTON_TRACK_ID = 'data-track-id';

// The DOM attribute the crawler follows. Only elements carrying it (set via
// `crawlFollow`) are clicked and explored during graph generation. A
// `data-track-id` on its own is reported as usage but not crawled.
export const BUTTON_FOLLOW_ID = 'data-follow-id';

type ButtonProps = ComponentPropsWithoutRef<'button'>;

export const TrackedButton: React.FC<
  ButtonProps & {
    trackId: string;
    // When set, the crawler follows this button: it emits `data-follow-id` with
    // the same value as `data-track-id`.
    crawlFollow?: boolean;
    children?: React.ReactNode;
  }
> = ({ trackId, crawlFollow, children, ...props }) => {
  return (
    <button
      {...{ [BUTTON_TRACK_ID]: trackId }}
      {...(crawlFollow ? { [BUTTON_FOLLOW_ID]: trackId } : {})}
      {...props}
    >
      {children}
    </button>
  );
};
