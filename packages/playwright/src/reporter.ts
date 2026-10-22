import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import playwrightPackage from '@playwright/test/package.json' with { type: 'json' };
import type {
  FullConfig,
  FullResult,
  Reporter,
  TestCase,
  TestResult,
} from '@playwright/test/reporter';

import packageInfo from '../package.json';
import { resolveMode } from './config';
import { MANIFEST_ATTACHMENT, REPORTER_ENV } from './recorder';
import type { RawGraphManifest, RawGraph, RawGraphFile } from './types';
import {
  RAW_GRAPH_BUNDLE_INDEX,
  prepareArtifactUpload,
  registerDeployment,
  resolveUploadOptions,
  resultLink,
  bundleImagePath,
  bundleSnapshotPath,
  uploadRawGraph,
  type PreparedUpload,
  type RawGraphAriaSnapshot,
  type RawGraphBundleIndex,
  type RawGraphScreenshot,
} from './upload';

export type RalphReporterOptions = {
  /**
   * `upload` uploads the merged raw graph. Defaults to `RALPH_MODE`, else
   * `upload` when `RALPH_UPLOAD_KEY` is set. The run is also uploaded when any
   * test ran in `upload` mode.
   */
  mode?: 'off' | 'local' | 'upload';
  /** Your Ralph server. Defaults to `RALPH_API_URL`, else `https://api.ralphralph.ai`. */
  apiUrl?: string;
  /** The app the recordings belong to. Defaults to `RALPH_APP_ID`. */
  appId?: string;
  /** How long the upload may take, in milliseconds. Defaults to 120000. */
  uploadTimeoutMs?: number;
  /**
   * Upload the run as the graph of the deployed build `RALPH_BUILD_ID` names,
   * rather than as a standalone result. See `registerDeployment`. Defaults to
   * `RALPH_DEPLOY` being `1`.
   */
  deploy?: boolean;
  /**
   * Where the merged raw graph is written, laid out like the uploaded bundle.
   * Defaults to `ralph` inside the first project's output directory.
   */
  outputDir?: string;
};

/** One test's final attempt, as the reporter collected it. */
type Collected = {
  file: RawGraphFile;
  status: TestResult['status'];
  /** Screenshot and snapshot attachment paths or preserved bodies, by attachment name. */
  attachments: Map<string, string | Buffer>;
};

/**
 * Merges every recorded test's raw graph into one for the whole run, writes it
 * locally, and uploads it once when the mode is `upload`.
 *
 * Tests run in worker processes, so only a reporter, in the main process,
 * sees them all. For a sharded run, it runs in `playwright merge-reports` over
 * the shards' blob reports.
 */
export default class RalphReporter implements Reporter {
  private readonly startedAt = new Date().toISOString();
  private config?: FullConfig;

  /**
   * By test id, so a retry replaces the attempt before it. Read as each test
   * ends, and awaited in `onEnd`.
   */
  private readonly tests = new Map<string, Promise<Collected | undefined>>();

  constructor(private readonly options: RalphReporterOptions = {}) {
    // Before any worker starts, so the fixtures can tell the reporter is on.
    process.env[REPORTER_ENV] = '1';
    if (resolveMode(options) === 'upload') {
      // Throws, so missing credentials stop the run before any test.
      resolveUploadOptions(options);
    }
  }

  onBegin(config: FullConfig): void {
    this.config = config;
  }

  onTestEnd(test: TestCase, result: TestResult): void {
    const collected = collect(result);
    // Rejections are reported in `onEnd`; this only stops Node from calling
    // them unhandled in the meantime.
    collected.catch(() => undefined);
    this.tests.set(test.id, collected);
  }

  async onEnd(): Promise<{ status?: FullResult['status'] } | undefined> {
    try {
      const collected = (await Promise.all(this.tests.values())).filter(
        (item) => item !== undefined,
      );
      if (collected.length === 0) {
        return undefined;
      }

      const merged = this.merge(collected);
      const screenshots = await Promise.all(
        merged.images.map(
          async ({ source, ...image }): Promise<RawGraphScreenshot> => ({
            ...image,
            bytes: typeof source === 'string' ? await readFile(source) : source,
          }),
        ),
      );
      const snapshots = await Promise.all(
        merged.snapshots.map(
          async ({ nodeId, source }): Promise<RawGraphAriaSnapshot> => ({
            nodeId,
            bytes: typeof source === 'string' ? await readFile(source) : source,
          }),
        ),
      );
      const uploading =
        resolveMode(this.options) === 'upload' ||
        collected.some(({ file }) => file.mode === 'upload');

      // Before the local copy is written, so it names the same artifact as the
      // upload, and the link is printed as soon as it works.
      let prepared: PreparedUpload | undefined;
      if (uploading) {
        try {
          prepared = await this.reserve(merged.manifest);
        } catch (error) {
          const outputDir = await this.write(
            merged.manifest,
            screenshots,
            snapshots,
          );
          throw new Error(
            `${error instanceof Error ? error.message : String(error)} The recording was saved to ${outputDir}.`,
            { cause: error },
          );
        }
        log(
          `Ralph: uploading the run. Follow the upload and processing at ${resultLink(prepared)}`,
        );
      }
      const manifest =
        prepared === undefined
          ? merged.manifest
          : { ...merged.manifest, artifactId: prepared.artifactId };
      const nodeCount = manifest.rawGraphs.reduce(
        (total, graph) => total + graph.nodes.length,
        0,
      );
      const outputDir = await this.write(manifest, screenshots, snapshots);
      log(
        `Ralph: merged ${manifest.rawGraphs.length} test(s), ${nodeCount} node(s) into ${outputDir}`,
      );

      if (prepared !== undefined) {
        const receipt = await uploadRawGraph(
          manifest,
          screenshots,
          resolveUploadOptions(this.options),
          snapshots,
        ).catch((error: unknown) => {
          throw new Error(
            `${error instanceof Error ? error.message : String(error)} The recording was saved to ${outputDir}.`,
            { cause: error },
          );
        });
        await writeFile(
          path.join(outputDir, 'upload_receipt.json'),
          JSON.stringify(receipt, null, 2) + '\n',
        );
        log(
          `Ralph: uploaded the run. Ralph is processing it at ${resultLink(receipt)}`,
        );
      }
      return undefined;
    } catch (error) {
      console.error(
        'Ralph: ' + (error instanceof Error ? error.message : String(error)),
      );
      return { status: 'failed' };
    }
  }

  private reserve(manifest: RawGraphManifest): Promise<PreparedUpload> {
    const options = resolveUploadOptions(this.options);
    const deploy = this.options.deploy ?? process.env['RALPH_DEPLOY'] === '1';
    if (!deploy) {
      return prepareArtifactUpload(options);
    }

    if (manifest.buildId === undefined) {
      throw new Error(
        'A deployment run uploads into its build, so set RALPH_BUILD_ID (or the buildId option) to the deployed build.',
      );
    }
    return registerDeployment(options, {
      buildId: manifest.buildId,
      config: manifest.config.config,
    });
  }

  printsToStdio(): boolean {
    return false;
  }

  /** Merges the tests into one manifest, with where to read their screenshots and snapshots. */
  private merge(collected: Collected[]): {
    manifest: RawGraphManifest;
    images: (Omit<RawGraphScreenshot, 'bytes'> & { source: string | Buffer })[];
    snapshots: { nodeId: string; source: string | Buffer }[];
  } {
    const [first] = collected;
    const same = (pick: (file: RawGraphFile) => unknown, what: string) => {
      const expected = JSON.stringify(pick(first!.file));
      if (
        collected.some(({ file }) => JSON.stringify(pick(file)) !== expected)
      ) {
        throw new Error(
          `Every recorded test in a run must share one ${what}; merge them per run.`,
        );
      }
    };
    same((file) => file.config, 'Ralph config');
    same((file) => [file.runId, file.buildId], 'runId and buildId');

    const images: (Omit<RawGraphScreenshot, 'bytes'> & {
      source: string | Buffer;
    })[] = [];
    const snapshots: { nodeId: string; source: string | Buffer }[] = [];
    const rawGraphs = collected
      .map(({ file, status, attachments }): RawGraph => {
        const nodes = file.rawGraph.nodes.map((node) => {
          if (node.status !== 'recorded') {
            return node;
          }
          const source = attachments.get(node.screenshot.attachmentName);
          if (source === undefined) {
            throw new Error(
              `The screenshot of node ${node.nodeId} is missing from the test results.`,
            );
          }
          images.push({
            nodeId: node.nodeId,
            contentType: node.screenshot.contentType,
            source,
          });
          // A snapshot is optional, so one missing from the results drops
          // from the node rather than failing the run.
          const snapshot =
            node.ariaSnapshot &&
            attachments.get(node.ariaSnapshot.attachmentName);
          if (snapshot !== undefined) {
            snapshots.push({ nodeId: node.nodeId, source: snapshot });
          }
          const { ariaSnapshot, ...rest } = node;
          return {
            ...rest,
            screenshot: {
              ...node.screenshot,
              path: bundleImagePath(node.nodeId, node.screenshot.contentType),
            },
            ...(ariaSnapshot &&
              snapshot !== undefined && {
                ariaSnapshot: {
                  ...ariaSnapshot,
                  path: bundleSnapshotPath(node.nodeId),
                },
              }),
          };
        });
        return {
          ...file.rawGraph,
          // The final status, which includes failures after the recorder
          // finished, such as a later fixture's teardown.
          status,
          nodes,
          complete: file.rawGraph.complete && status === 'passed',
        };
      })
      .sort(
        (a, b) =>
          a.project.localeCompare(b.project) ||
          a.titlePath.join('\0').localeCompare(b.titlePath.join('\0')) ||
          a.repeatEachIndex - b.repeatEachIndex,
      );

    const manifest: RawGraphManifest = {
      formatVersion: 1,
      producer: {
        name: '@ralphralphai/playwright',
        version: packageInfo.version,
        playwrightVersion: playwrightPackage.version,
      },
      runId: first!.file.runId,
      buildId: first!.file.buildId,
      // Replaced by the prepared artifact's id when the run is uploaded.
      artifactId: randomUUID(),
      shard: this.config?.shard ?? null,
      startedAt: this.startedAt,
      finishedAt: new Date().toISOString(),
      config: first!.file.config,
      rawGraphs,
      complete: rawGraphs.every((graph) => graph.complete),
    };

    return {
      manifest,
      images,
      snapshots,
    };
  }

  /** Writes the manifest, screenshots and snapshots in the bundle's layout. */
  private async write(
    manifest: RawGraphManifest,
    screenshots: RawGraphScreenshot[],
    snapshots: RawGraphAriaSnapshot[],
  ): Promise<string> {
    const outputDir = path.resolve(
      this.options.outputDir ??
        path.join(
          this.config?.projects[0]?.outputDir ??
            path.join(this.config?.rootDir ?? process.cwd(), 'test-results'),
          'ralph',
        ),
    );
    await rm(outputDir, { recursive: true, force: true });

    const index: RawGraphBundleIndex = {
      manifest,
      screenshots: [],
      snapshots: [],
    };
    for (const { nodeId, contentType, bytes } of screenshots) {
      const imagePath = bundleImagePath(nodeId, contentType);
      index.screenshots.push({ nodeId, path: imagePath });
      await mkdir(path.dirname(path.join(outputDir, imagePath)), {
        recursive: true,
      });
      await writeFile(path.join(outputDir, imagePath), bytes);
    }
    for (const { nodeId, bytes } of snapshots) {
      const snapshotPath = bundleSnapshotPath(nodeId);
      index.snapshots.push({ nodeId, path: snapshotPath });
      await mkdir(path.dirname(path.join(outputDir, snapshotPath)), {
        recursive: true,
      });
      await writeFile(path.join(outputDir, snapshotPath), bytes);
    }
    await mkdir(outputDir, { recursive: true });
    await writeFile(
      path.join(outputDir, RAW_GRAPH_BUNDLE_INDEX),
      JSON.stringify(index, null, 2) + '\n',
    );
    return outputDir;
  }
}

/** Reads a test's raw graph from its attachments; undefined if it recorded nothing. */
async function collect(result: TestResult): Promise<Collected | undefined> {
  const manifest = result.attachments.find(
    (item) => item.name === MANIFEST_ATTACHMENT,
  );
  if (!manifest || (!manifest.body && !manifest.path)) {
    return undefined;
  }
  const file = JSON.parse(
    manifest.body?.toString('utf8') ?? (await readFile(manifest.path!, 'utf8')),
  ) as RawGraphFile;
  const attachments = new Map<string, string | Buffer>();
  for (const { name, path: attachmentPath, body } of result.attachments) {
    const source = body ?? attachmentPath;
    if (source !== undefined) {
      attachments.set(name, source);
    }
  }
  return { file, status: result.status, attachments };
}

function log(message: string): void {
  process.stdout.write(message + '\n');
}
