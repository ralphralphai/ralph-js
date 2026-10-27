/** Runs in the page. Keeps native animations and DOM changes observable without app hooks. */
export function observeAnimations() {
  const paused = new Set<Animation>();
  const roots = new Set<Document | ShadowRoot>();
  let dirty = true;
  const observer = new MutationObserver(() => {
    dirty = true;
  });

  const collect = (root: Document | ShadowRoot, all: Set<Animation>) => {
    if (!roots.has(root)) {
      roots.add(root);
      observer.observe(root, {
        subtree: true,
        childList: true,
        attributes: true,
        characterData: true,
      });
      dirty = true;
    }
    root.getAnimations().forEach((animation) => all.add(animation));
    for (const element of root.querySelectorAll('*')) {
      if (element.shadowRoot) {
        collect(element.shadowRoot, all);
      }
    }
  };

  return {
    sample(finishFinite: boolean): boolean {
      const all = new Set<Animation>();
      collect(document, all);
      let changed = dirty;
      dirty = false;

      for (const animation of all) {
        // Preserve animations the app deliberately paused.
        if (animation.playState !== 'running') {
          continue;
        }
        if (
          finishFinite &&
          animation.playbackRate !== 0 &&
          Number.isFinite(animation.effect?.getComputedTiming().endTime)
        ) {
          animation.finish();
        } else {
          animation.pause();
          paused.add(animation);
        }
        changed = true;
      }
      return changed;
    },
    async ready(): Promise<void> {
      await Promise.all([...paused].map((animation) => animation.ready));
    },
    resume(): void {
      observer.disconnect();
      for (const animation of paused) {
        // Do not restart an animation the app canceled meanwhile.
        if (animation.playState === 'paused') {
          animation.play();
        }
      }
    },
  };
}

export type AnimationObserver = ReturnType<typeof observeAnimations>;
