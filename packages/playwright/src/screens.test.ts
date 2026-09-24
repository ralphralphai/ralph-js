import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { TestInfo } from '@playwright/test';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { applyScreenSelection, ralphProjects } from './screens';

const screenSizes = [
  { width: 375, height: 812 },
  { width: 1280, height: 720 },
];

describe('ralphProjects', () => {
  const temporary: string[] = [];
  afterEach(async () => {
    await Promise.all(
      temporary
        .splice(0)
        .map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  it('expands a base project into one project per screen size', () => {
    const projects = ralphProjects(
      {
        name: 'chromium',
        grep: /@ralph/,
        use: { browserName: 'chromium', viewport: { width: 1, height: 1 } },
        metadata: { team: 'web' },
      },
      { config: { screenSizes } },
    );
    expect(projects.map((project) => project.name)).toEqual([
      'chromium 375x812',
      'chromium 1280x720',
    ]);
    expect(projects[0]).toMatchObject({
      grep: /@ralph/,
      use: { browserName: 'chromium', viewport: { width: 375, height: 812 } },
      metadata: {
        team: 'web',
        ralph: { screenSize: screenSizes[0], screenSizes },
      },
    });
  });

  it('reads the config file synchronously relative to the root', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'ralph-screens-'));
    temporary.push(dir);
    await writeFile(
      path.join(dir, 'ralph.jsonc'),
      '{ "screenSizes": [{ "width": 390, "height": 844 },], }',
    );
    expect(ralphProjects({}, { root: dir }).map((item) => item.name)).toEqual([
      '390x844',
    ]);
  });

  it('rejects configs without screen sizes', () => {
    expect(() => ralphProjects({}, { config: { screenSizes: [] } })).toThrow(
      'no screenSizes',
    );
  });
});

describe('applyScreenSelection', () => {
  function info(tags: string[], size?: (typeof screenSizes)[number]) {
    const skip = vi.fn();
    const testInfo = {
      tags,
      skip,
      project: {
        metadata: size ? { ralph: { screenSize: size, screenSizes } } : {},
      },
    } as unknown as TestInfo;
    return { testInfo, skip };
  }

  it('runs untagged tests at every screen size', () => {
    const { testInfo, skip } = info(['@ralph'], screenSizes[0]);
    applyScreenSelection(testInfo);
    expect(skip).not.toHaveBeenCalled();
  });

  it('skips screen sizes a test does not select', () => {
    const tags = ['@ralph', '@ralph-screen:375x812'];
    const mobile = info(tags, screenSizes[0]);
    applyScreenSelection(mobile.testInfo);
    expect(mobile.skip).toHaveBeenCalledWith(false, expect.any(String));
    const desktop = info(tags, screenSizes[1]);
    applyScreenSelection(desktop.testInfo);
    expect(desktop.skip).toHaveBeenCalledWith(
      true,
      'Not selected for Ralph screen size 1280x720.',
    );
  });

  it('rejects sizes missing from the config', () => {
    const { testInfo } = info(['@ralph-screen:375x800'], screenSizes[0]);
    expect(() => applyScreenSelection(testInfo)).toThrow(
      'Unknown Ralph screen size 375x800',
    );
  });

  it('ignores projects that ralphProjects did not create', () => {
    const { testInfo, skip } = info(['@ralph-screen:375x812']);
    applyScreenSelection(testInfo);
    expect(skip).not.toHaveBeenCalled();
  });
});
