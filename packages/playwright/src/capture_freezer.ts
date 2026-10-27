import { setTimeout as delay } from 'node:timers/promises';

import type { BrowserContext, Frame, JSHandle, Page } from '@playwright/test';

import {
  observeAnimations,
  type AnimationObserver,
} from './animation_observer';

// pauseAt accepts an absolute future time, not "pause now". Leave room for
// the command to reach the browser. Use page time so repeated captures do not
// fast-forward through the wall-clock time spent on earlier captures.
const PAUSE_LEAD_MS = 100;
const ANIMATION_QUIET_MS = 150;
const MAX_ANIMATION_SETTLE_MS = 1500;

type AnimationObservers = Map<Frame, JSHandle<AnimationObserver>>;

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
    deadline = Date.now() + 5000,
  ): Promise<T> {
    const task = this.tail.then(async () => {
      signal.throwIfAborted();
      const animations: AnimationObservers = new Map();
      // Do not race these mutations against a timeout: a late pause could
      // otherwise complete after cleanup and leave the context frozen.
      try {
        await this.settleAnimations(page, animations, signal, deadline);
        await this.pauseClock(page, signal);
        signal.throwIfAborted();
        // Once time is frozen, only pause: finishing here could start new JS
        // work whose animation frames cannot run until after the screenshot.
        // Recheck after pause readiness for newly started native animations.
        for (let pass = 0; pass < 2; pass++) {
          await this.sampleAnimations(page, animations, signal, false);
          await this.waitForAnimationsReady(animations, signal);
        }
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

  private async settleAnimations(
    page: Page,
    animations: AnimationObservers,
    signal: AbortSignal,
    deadline: number,
  ): Promise<void> {
    const now = Date.now();
    // Leave at least half the remaining recording budget for capture. DOM
    // updates from looping JS animations must not consume the whole deadline.
    const endsAt =
      now +
      Math.min(MAX_ANIMATION_SETTLE_MS, Math.max(0, (deadline - now) / 2));
    let quietSince = now;
    while (Date.now() < endsAt) {
      if (await this.sampleAnimations(page, animations, signal, true)) {
        quietSince = Date.now();
      }
      if (Date.now() - quietSince >= ANIMATION_QUIET_MS) {
        return;
      }
      // The clock is still running. This gives completion callbacks, chained
      // animations and JS/rAF style updates a chance to reach their end state.
      await delay(Math.max(0, Math.min(50, endsAt - Date.now())), undefined, {
        signal,
      }).catch((error: unknown) => {
        signal.throwIfAborted();
        throw error;
      });
    }
  }

  private async sampleAnimations(
    page: Page,
    animations: AnimationObservers,
    signal: AbortSignal,
    finishFinite: boolean,
  ): Promise<boolean> {
    let changed = false;
    for (const frame of page.frames()) {
      signal.throwIfAborted();
      try {
        let handle = animations.get(frame);
        if (!handle) {
          handle = await frame.evaluateHandle(observeAnimations);
          animations.set(frame, handle);
        }
        changed =
          (await handle.evaluate(
            (state, finish) => state.sample(finish),
            finishFinite,
          )) || changed;
      } catch (error) {
        // Completion handlers can remove an iframe while it is settling.
        if (!frame.isDetached()) {
          throw error;
        }
      }
    }
    signal.throwIfAborted();
    return changed;
  }

  private async waitForAnimationsReady(
    animations: AnimationObservers,
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
          [...animations].map(async ([frame, handle]) => {
            if (frame.isDetached()) {
              return;
            }
            try {
              await handle.evaluate((state) => state.ready());
            } catch (error) {
              if (!frame.isDetached()) {
                throw error;
              }
            }
          }),
        ),
        aborted,
      ]);
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
  }

  private async resumeAnimations(
    animations: AnimationObservers,
  ): Promise<void> {
    const restored = await Promise.allSettled(
      [...animations.values()].map(async (handle) => {
        try {
          await handle.evaluate((state) => state.resume());
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
