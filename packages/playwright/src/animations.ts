import { errors, type Page } from '@playwright/test';

/**
 * Waits until no finite CSS animation, CSS transition, or Web Animation is
 * running. Infinite ones (spinners, shimmers) never finish, so they are
 * ignored. Animations driven by `requestAnimationFrame` are invisible here.
 *
 * Stops waiting after `timeoutMs` without failing; the screenshot then jumps
 * whatever is left to its end state.
 */
export async function waitForAnimations(
  page: Page,
  timeoutMs: number,
): Promise<void> {
  try {
    await page.waitForFunction(
      () =>
        document
          .getAnimations()
          .every(
            (animation) =>
              animation.playState !== 'running' ||
              animation.playbackRate === 0 ||
              !Number.isFinite(animation.effect?.getComputedTiming().endTime),
          ),
      undefined,
      // Polled every frame: animations often start a frame or two late.
      { polling: 'raf', timeout: Math.max(1, timeoutMs) },
    );
  } catch (error) {
    if (!(error instanceof errors.TimeoutError)) {
      throw error;
    }
  }
}
