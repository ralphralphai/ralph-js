import type { BrowserContext, JSHandle, Page } from '@playwright/test';

// pauseAt accepts an absolute future time, not "pause now". Leave room for
// the command to reach the browser. Use page time so repeated captures do not
// fast-forward through the wall-clock time spent on earlier captures.
const PAUSE_LEAD_MS = 100;

/** One owner of the context-wide clock; captures in different tabs queue here. */
export class CaptureFreezer {
  private tail: Promise<unknown> = Promise.resolve();
  private closed = false;

  constructor(private readonly context: BrowserContext) {
    context.once('close', () => {
      this.closed = true;
    });
  }

  install(): Promise<void> {
    if (this.context.pages().some((page) => page.url() !== 'about:blank')) {
      throw new Error(
        'Ralph freezeDuringCapture requires the clock before page scripts run. Await ralph.observe(context) before creating or navigating pages in a custom context.',
      );
    }
    return this.context.clock.install();
  }

  async capture<T>(
    page: Page,
    signal: AbortSignal,
    capture: () => Promise<T>,
  ): Promise<T> {
    const task = this.tail.then(async () => {
      signal.throwIfAborted();
      const animations: JSHandle<Animation[]>[] = [];
      // Do not race these mutations against a timeout: a late pause could
      // otherwise complete after cleanup and leave the context frozen.
      try {
        await this.pauseClock(page, signal);
        signal.throwIfAborted();
        for (const frame of page.frames()) {
          animations.push(
            await frame.evaluateHandle(() => {
              const all = new Set<Animation>();

              // Recursively collect all animations in the document and its
              // shadow roots.
              const collectAnimations = (root: Document | ShadowRoot) => {
                root.getAnimations().forEach((animation) => all.add(animation));
                for (const element of root.querySelectorAll('*')) {
                  if (element.shadowRoot) {
                    collectAnimations(element.shadowRoot);
                  }
                }
              };

              collectAnimations(document);

              const paused: Animation[] = [];
              try {
                for (const animation of all) {
                  if (animation.playState !== 'running') {
                    continue;
                  }

                  // A finite animation paused midway freezes wherever it
                  // happened to be, so two captures of the same page differ.
                  // Its end state is the one stable position, and the one the
                  // unfrozen screenshot's `animations: 'disabled'` shows.
                  const endTime = animation.effect?.getComputedTiming().endTime;
                  if (
                    animation.playbackRate !== 0 &&
                    Number.isFinite(endTime)
                  ) {
                    animation.finish();
                    continue;
                  }

                  animation.pause();
                  paused.push(animation);
                }
                return paused;
              } catch (error) {
                paused.forEach((animation) => animation.play());
                throw error;
              }
            }),
          );
          signal.throwIfAborted();
        }
        await this.waitForAnimationsReady(animations, signal);
        return await capture();
      } finally {
        try {
          await this.resumeAnimations(animations);
        } finally {
          if (!this.closed) {
            await this.context.clock.resume();
          }
        }
      }
    });

    // A failed or expired capture must not poison the next tab's turn.
    this.tail = task.catch(() => undefined);
    return task;
  }

  private async waitForAnimationsReady(
    animations: JSHandle<Animation[]>[],
    signal: AbortSignal,
  ): Promise<void> {
    signal.throwIfAborted();
    let onAbort!: () => void;
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => reject(signal.reason);
      signal.addEventListener('abort', onAbort, { once: true });
    });
    try {
      // pause() may finish on a later rendering frame. Wait before measuring,
      // keeping the handles available for cleanup if the deadline interrupts.
      // This only waits; it cannot perform a late pause after cleanup.
      await Promise.race([
        Promise.all(
          animations.map((handle) =>
            handle.evaluate(async (paused) => {
              await Promise.all(paused.map((animation) => animation.ready));
            }),
          ),
        ),
        aborted,
      ]);
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
  }

  private async resumeAnimations(
    animations: JSHandle<Animation[]>[],
  ): Promise<void> {
    const restored = await Promise.allSettled(
      animations.map(async (handle) => {
        try {
          await handle.evaluate((paused) => {
            for (const animation of paused) {
              // Do not restart an animation the app canceled meanwhile.
              if (animation.playState === 'paused') {
                animation.play();
              }
            }
          });
        } catch (error) {
          // Navigating or closing destroys these animations with their document.
          // Other failures must not silently leave them paused.
          if (!destroyedContext(error)) {
            throw error;
          }
        } finally {
          await handle.dispose();
        }
      }),
    );
    for (const result of restored) {
      if (result.status === 'rejected') {
        throw result.reason;
      }
    }
  }

  private async pauseClock(page: Page, signal: AbortSignal): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      const time = await page.evaluate(() => Date.now());
      signal.throwIfAborted();
      try {
        await this.context.clock.pauseAt(time + PAUSE_LEAD_MS);
        return;
      } catch (error) {
        // A slow transport can consume the lead time. Resample once; cleanup
        // still resumes every frame if either command only partially succeeds.
        if (
          attempt > 0 ||
          !(error instanceof Error) ||
          !error.message.includes('Cannot fast-forward to the past')
        ) {
          throw error;
        }
      }
    }
  }
}

function destroyedContext(error: unknown): boolean {
  return (
    error instanceof Error &&
    /Execution context was destroyed|Cannot find context|Target page, context or browser has been closed|Frame was detached/.test(
      error.message,
    )
  );
}
