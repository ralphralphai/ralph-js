import path from 'node:path';

import { test as base } from '@playwright/test';
import type {
  PlaywrightTestArgs,
  PlaywrightTestOptions,
  PlaywrightWorkerArgs,
  PlaywrightWorkerOptions,
  TestType,
} from '@playwright/test';

import { loadConfig, resolveMode } from './config';
import { Recorder } from './recorder';
import { applyScreenSelection } from './screens';
import type { ConfigSnapshot, Ralph, RalphOptions } from './types';
import { resolveUploadOptions } from './upload';

export { expect, mergeTests } from '@playwright/test';
export type { WebRalphConfig } from '@ralphralphai/config';
export { createRawGraphBundle, uploadRawGraph } from './upload';
export type {
  UploadOptions,
  UploadReceipt,
  RawGraphScreenshot,
  RawGraphBundleIndex,
} from './upload';
export { MANIFEST_ATTACHMENT } from './recorder';
export { ralphProjects, SCREEN_TAG_PREFIX } from './screens';
export type { RalphProjectOptions } from './screens';
export type {
  RawGraphManifest,
  RawNode,
  RecordNodeOptions,
  ConfigSnapshot,
  PageLayout,
  Ralph,
  RalphOptions,
  TrackedElement,
} from './types';

export type RalphFixtures = { ralph: Ralph; ralphOptions: RalphOptions };

type InternalFixtures = {
  _ralphScreen: void;
  _ralphRecorder: Recorder | null;
};
type WorkerFixtures = { _ralphConfigs: Map<string, Promise<ConfigSnapshot>> };

export const test: TestType<
  PlaywrightTestArgs & PlaywrightTestOptions & RalphFixtures,
  PlaywrightWorkerArgs & PlaywrightWorkerOptions
> = base.extend<RalphFixtures & InternalFixtures, WorkerFixtures>({
  ralphOptions: [{}, { option: true }],
  _ralphConfigs: [
    // Playwright requires destructuring here to discover fixture dependencies.
    // oxlint-disable-next-line no-empty-pattern
    async ({}, use) => {
      await use(new Map());
    },
    { scope: 'worker' },
  ],
  _ralphScreen: [
    // Playwright requires destructuring here to discover fixture dependencies.
    // oxlint-disable-next-line no-empty-pattern
    async ({}, use, testInfo) => {
      // Screen selection chooses which flows run, so it applies in every mode.
      applyScreenSelection(testInfo);
      await use();
    },
    { auto: true },
  ],
  _ralphRecorder: [
    // _ralphScreen is specified here so that the playwright treat that it is
    // a dependency of this fixture.
    async ({ ralphOptions, _ralphConfigs, _ralphScreen }, use, testInfo) => {
      if (
        !testInfo.tags.includes('@ralph') ||
        resolveMode(ralphOptions) === 'off'
      ) {
        await use(null);
        return;
      }

      const upload =
        resolveMode(ralphOptions) === 'upload'
          ? resolveUploadOptions(ralphOptions)
          : undefined;

      const root = testInfo.config.configFile
        ? path.dirname(testInfo.config.configFile)
        : process.cwd();

      const key = JSON.stringify({
        root,
        config: ralphOptions.config,
        configPath: ralphOptions.configPath,
      });

      let pending = _ralphConfigs.get(key);
      if (!pending) {
        pending = loadConfig(ralphOptions, root);
        _ralphConfigs.set(key, pending);
      }

      const recorder = new Recorder(
        ralphOptions,
        await pending,
        testInfo,
        upload,
      );

      try {
        await use(recorder);
      } finally {
        await recorder.finish();
      }
    },
    { auto: true, timeout: 30_000 },
  ],
  ralph: async ({ _ralphRecorder, ralphOptions }, use) => {
    const checkOptIn = () => {
      if (resolveMode(ralphOptions) !== 'off') {
        throw new Error('Opt this test into Ralph with the @ralph tag.');
      }
    };

    await use(
      _ralphRecorder ?? {
        recordNode: async () => {
          checkOptIn();
        },
        flush: async () => {},
        observe: () => {
          checkOptIn();
        },
      },
    );
  },
  context: async ({ context, _ralphRecorder }, use) => {
    _ralphRecorder?.observe(context);
    try {
      await use(context);
    } finally {
      // The base context fixture closes its pages next; pending recordings still need them alive.
      await _ralphRecorder?.stopContext(context);
    }
  },
});
