import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { loadConfig, resolveMode } from './config';

const temporary: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    temporary.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function directory() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ralph-config-'));
  temporary.push(dir);
  return dir;
}

describe('config snapshots', () => {
  it('preserves JSONC values without applying schema defaults', async () => {
    const dir = await directory();
    await writeFile(
      path.join(dir, 'ralph.jsonc'),
      '{ "screenSizes": [], "simpleUrlCrawlRules": [{ "scenario": { "startUrl": "https://a.co", }, },], }',
    );
    const snapshot = await loadConfig({}, dir);
    expect(snapshot.config).toEqual({
      screenSizes: [],
      simpleUrlCrawlRules: [{ scenario: { startUrl: 'https://a.co' } }],
    });
    expect(snapshot.packageVersion).toBe('2.0.0');
  });

  it('detaches an inline snapshot from subsequent mutations', async () => {
    const config = { screenSizes: [{ width: 500, height: 400 }] };
    const snapshot = await loadConfig({ config }, '/unused');
    config.screenSizes[0].width = 900;
    expect(snapshot.config.screenSizes[0].width).toBe(500);
  });

  it('rejects malformed files and configs that fail the published schema', async () => {
    const dir = await directory();
    await writeFile(path.join(dir, 'ralph.jsonc'), '{ "screenSizes": [ ');
    await expect(loadConfig({}, dir)).rejects.toThrow('Invalid Ralph config');
    await writeFile(path.join(dir, 'ralph.jsonc'), '{ "screenSizes": "bad" }');
    await expect(loadConfig({}, dir)).rejects.toThrow();
  });

  it('rejects ambiguous config sources', async () => {
    await expect(
      loadConfig(
        { config: { screenSizes: [] }, configPath: 'ralph.jsonc' },
        '/unused',
      ),
    ).rejects.toThrow('either');
  });
});

describe('recording modes', () => {
  it('defaults to off without credentials', () => {
    vi.stubEnv('RALPH_MODE', undefined);
    vi.stubEnv('RALPH_UPLOAD_KEY', undefined);
    expect(resolveMode({})).toBe('off');
  });

  it('allows explicit off to override CI credentials and mode', () => {
    vi.stubEnv('RALPH_MODE', 'upload');
    vi.stubEnv('RALPH_UPLOAD_KEY', 'secret');
    expect(resolveMode({ mode: 'off' })).toBe('off');
  });

  it('selects upload mode and rejects invalid modes', () => {
    vi.stubEnv('RALPH_MODE', 'upload');
    expect(resolveMode({})).toBe('upload');
    vi.stubEnv('RALPH_MODE', 'typo');
    expect(() => resolveMode({})).toThrow('off, local, or upload');
  });
});
