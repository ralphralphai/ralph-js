import type { FlowRun, FlowRunHandle } from './types';

const MAX_FLOW_NAME_LENGTH = 64;

type Run = {
  name: string;
  startedAt: string;
  nodeIds: string[];
  ended?: { at: string; by: FlowRun['endedBy'] };
};

export class FlowRuns {
  private readonly runs: Run[] = [];
  private readonly retainedNodeIds = new Map<string, string>();

  /** `currentNodeId` is the node on screen, the run's first step. */
  start(name: string, currentNodeId: string | undefined): FlowRunHandle {
    const flowName = flowNameOf(name);
    if (this.openRun(flowName)) {
      throw new Error(`Ralph flow "${flowName}" is already open.`);
    }

    const run: Run = {
      name: flowName,
      startedAt: new Date().toISOString(),
      nodeIds: currentNodeId === undefined ? [] : [currentNodeId],
    };
    this.runs.push(run);

    return {
      name: flowName,
      end: () => {
        if (run.ended) {
          throw new Error(
            `This run of Ralph flow "${flowName}" has already ended.`,
          );
        }
        endRun(run, 'endFlow');
      },
    };
  }

  end(name: string): void {
    const flowName = flowNameOf(name);
    const run = this.openRun(flowName);
    if (!run) {
      throw new Error(`Ralph flow "${flowName}" is not open.`);
    }
    endRun(run, 'endFlow');
  }

  nodeRequested(nodeId: string): void {
    for (const run of this.runs) {
      if (!run.ended) {
        run.nodeIds.push(nodeId);
      }
    }
  }

  /** A retake or unchanged condition update kept an existing node's ID. */
  nodeReused(requestId: string, retainedNodeId: string): void {
    this.retainedNodeIds.set(requestId, retainedNodeId);
  }

  /** Ends the runs still open, as the test has, and returns every run. */
  finish(): FlowRun[] {
    return this.runs.map((run) => {
      if (!run.ended) {
        endRun(run, 'test-end');
      }
      return {
        name: run.name,
        startedAt: run.startedAt,
        endedAt: run.ended!.at,
        endedBy: run.ended!.by,
        // Resolve at the end: a run may close before its captures finish, or
        // start on a request whose capture already reused another node.
        nodeIds: run.nodeIds.map(
          (nodeId) => this.retainedNodeIds.get(nodeId) ?? nodeId,
        ),
      };
    });
  }

  private openRun(name: string): Run | undefined {
    return this.runs.find((run) => run.name === name && !run.ended);
  }
}

function endRun(run: Run, by: FlowRun['endedBy']): void {
  run.ended = { at: new Date().toISOString(), by };
}

function flowNameOf(name: string): string {
  const trimmed = name.trim();
  if (!trimmed || trimmed.length > MAX_FLOW_NAME_LENGTH) {
    throw new Error(
      `A Ralph flow name must be 1 to ${MAX_FLOW_NAME_LENGTH} characters.`,
    );
  }
  return trimmed;
}
