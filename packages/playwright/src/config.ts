import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import configPackage from '@ralphralphai/config/package.json' with { type: 'json' };
import { WebRalphConfigSchema } from '@ralphralphai/config/zod';
import { parse, printParseErrorCode, type ParseError } from 'jsonc-parser';

import type { ConfigSnapshot, RalphOptions } from './types';

export function resolveMode(options: RalphOptions): 'off' | 'local' | 'upload' {
  const mode =
    options.mode ??
    process.env['RALPH_MODE'] ??
    (process.env['RALPH_UPLOAD_KEY'] ? 'upload' : 'off');
  if (mode === 'off' || mode === 'local' || mode === 'upload') {
    return mode;
  }

  throw new Error('RALPH_MODE must be off, local, or upload.');
}

type ConfigSource = Pick<RalphOptions, 'config' | 'configPath'>;

export async function loadConfig(
  options: ConfigSource,
  root: string,
): Promise<ConfigSnapshot> {
  const file = configFile(options, root);
  return snapshot(options.config ?? parseConfig(await readFile(file, 'utf8')));
}

// Playwright config files may be CommonJS, so project generation cannot await.
export function loadConfigSync(
  options: ConfigSource,
  root: string,
): ConfigSnapshot {
  const file = configFile(options, root);
  return snapshot(options.config ?? parseConfig(readFileSync(file, 'utf8')));
}

function configFile(options: ConfigSource, root: string): string {
  if (options.config && options.configPath) {
    throw new Error(
      'Provide either ralphOptions.config or configPath, not both.',
    );
  }
  return path.resolve(root, options.configPath ?? 'ralph.jsonc');
}

function parseConfig(text: string): unknown {
  const errors: ParseError[] = [];
  const value: unknown = parse(text, errors, { allowTrailingComma: true });
  if (errors.length) {
    throw new Error(
      'Invalid Ralph config: ' +
        errors
          .map(
            (error) => printParseErrorCode(error.error) + ' at ' + error.offset,
          )
          .join(', '),
    );
  }
  return value;
}

function snapshot(value: unknown): ConfigSnapshot {
  WebRalphConfigSchema.parse(value);
  return {
    config: JSON.parse(JSON.stringify(value)) as ConfigSnapshot['config'],
    packageVersion: configPackage.version,
  };
}
