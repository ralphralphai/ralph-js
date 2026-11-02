import { describe, expect, it } from 'vitest';

import { FlowRuns } from './flows';

describe('FlowRuns', () => {
  it('starts on the node on screen and collects nodes until it ends', () => {
    const flows = new FlowRuns();
    flows.nodeRequested('before');
    flows.start('Sign up', 'home');
    flows.nodeRequested('signup');
    flows.nodeRequested('email');
    flows.end('Sign up');
    flows.nodeRequested('settings');

    expect(flows.finish()).toMatchObject([
      {
        name: 'Sign up',
        endedBy: 'endFlow',
        nodeIds: ['home', 'signup', 'email'],
      },
    ]);
  });

  it('starts with the next node when none was requested yet', () => {
    const flows = new FlowRuns();
    flows.start('Sign up', undefined);
    flows.nodeRequested('home');

    expect(flows.finish()[0].nodeIds).toEqual(['home']);
  });

  it('ends a run left open at test end', () => {
    const flows = new FlowRuns();
    flows.start('Onboarding', 'home');

    expect(flows.finish()[0].endedBy).toBe('test-end');
  });

  it('collects a node into every open flow', () => {
    const flows = new FlowRuns();
    flows.start('Sign up', 'home');
    flows.nodeRequested('signup');
    flows.start('Onboarding', 'signup');
    flows.nodeRequested('welcome');

    expect(
      flows.finish().map((run) => {
        return [run.name, run.nodeIds];
      }),
    ).toEqual([
      ['Sign up', ['home', 'signup', 'welcome']],
      ['Onboarding', ['signup', 'welcome']],
    ]);
  });

  it('keeps each run of one flow separate', () => {
    const flows = new FlowRuns();
    flows.start('Sign up', 'a');
    flows.end('Sign up');
    flows.start('Sign up', 'b');

    expect(
      flows.finish().map((run) => {
        return run.nodeIds;
      }),
    ).toEqual([['a'], ['b']]);
  });

  it('resolves reused nodes even when captures finish after a flow ends', () => {
    const flows = new FlowRuns();
    const first = flows.start('First', 'home');
    flows.nodeRequested('retake');
    first.end();

    const during = flows.start('During capture', 'retake');
    during.end();
    flows.nodeReused('retake', 'home');

    flows.start('After capture', 'retake');
    flows.nodeRequested('next');
    expect(flows.finish().map((run) => [run.name, run.nodeIds])).toEqual([
      ['First', ['home', 'home']],
      ['During capture', ['home']],
      ['After capture', ['home', 'next']],
    ]);
  });

  it('trims names and rejects empty or long ones', () => {
    const flows = new FlowRuns();
    expect(flows.start('  Sign up ', 'a').name).toBe('Sign up');
    expect(() => flows.start('   ', 'a')).toThrow('1 to 64');
    expect(() => flows.start('x'.repeat(65), 'a')).toThrow('1 to 64');
  });

  it('throws on starting an open flow or ending a closed one', () => {
    const flows = new FlowRuns();
    flows.start('Sign up', 'a');
    expect(() => flows.start('Sign up', 'b')).toThrow('already open');
    flows.end('Sign up');
    expect(() => flows.end('Sign up')).toThrow('not open');
  });

  it('ends only the run a handle came from', () => {
    const flows = new FlowRuns();
    const first = flows.start('Sign up', 'a');
    first.end();
    flows.start('Sign up', 'b');

    expect(() => first.end()).toThrow('already ended');
    flows.nodeRequested('c');
    expect(flows.finish()[1]).toMatchObject({
      endedBy: 'test-end',
      nodeIds: ['b', 'c'],
    });
  });
});
