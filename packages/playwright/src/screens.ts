import type {
  PlaywrightTestOptions,
  PlaywrightWorkerOptions,
  Project,
  TestInfo,
} from '@playwright/test';
import type { ScreenSize } from '@ralphralphai/config';

import { loadConfigSync } from './config';
import type { RalphOptions } from './types';

type RalphProject = Project<
  PlaywrightTestOptions & { ralphOptions: RalphOptions },
  PlaywrightWorkerOptions
>;

export const SCREEN_TAG_PREFIX = '@ralph-screen:';

export type RalphProjectOptions = Pick<
  RalphOptions,
  'config' | 'configPath'
> & {
  /** Resolves a relative `configPath`; defaults to the current directory. */
  root?: string;
};

type ScreenMetadata = { screenSize: ScreenSize; screenSizes: ScreenSize[] };

export function screenLabel(size: ScreenSize): string {
  return size.width + 'x' + size.height;
}

/**
 * Expands `base` into one project per `screenSizes` entry of the Ralph config.
 * Each project's viewport is that screen size.
 */
export function ralphProjects(
  base: RalphProject = {},
  options: RalphProjectOptions = {},
): RalphProject[] {
  const { screenSizes } = loadConfigSync(
    options,
    options.root ?? process.cwd(),
  ).config;
  if (!screenSizes.length) {
    throw new Error('The Ralph config declares no screenSizes.');
  }
  return screenSizes.map((screenSize) => {
    const label = screenLabel(screenSize);
    const ralph: ScreenMetadata = { screenSize, screenSizes };
    return {
      ...base,
      name: base.name ? base.name + ' ' + label : label,
      use: {
        ...base.use,
        viewport: { width: screenSize.width, height: screenSize.height },
      },
      metadata: { ...base.metadata, ralph },
    };
  });
}

/**
 * Skips a test whose `@ralph-screen:WxH` tags exclude the current project's
 * screen size. Untagged tests run at every size; other projects are untouched.
 */
export function applyScreenSelection(testInfo: TestInfo): void {
  const selected = testInfo.tags
    .filter((tag) => tag.startsWith(SCREEN_TAG_PREFIX))
    .map((tag) => tag.slice(SCREEN_TAG_PREFIX.length));
  const metadata = (testInfo.project.metadata as { ralph?: ScreenMetadata })
    .ralph;
  if (!selected.length || !metadata) {
    return;
  }
  const known = metadata.screenSizes.map(screenLabel);
  const unknown = selected.filter((label) => !known.includes(label));
  if (unknown.length) {
    throw new Error(
      'Unknown Ralph screen size ' +
        unknown.join(', ') +
        '; the config declares ' +
        known.join(', ') +
        '.',
    );
  }
  const current = screenLabel(metadata.screenSize);
  testInfo.skip(
    !selected.includes(current),
    'Not selected for Ralph screen size ' + current + '.',
  );
}
