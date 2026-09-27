import { mkdtempSync, rmSync, writeFileSync, mkdirSync, linkSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createSessionInputHoldStore } from './sessionInputHoldStore';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('session input hold', () => {
  it('persists one action fence and rejects a different release', () => {
    const dir = mkdtempSync(join(tmpdir(), 'happier-usage-hold-'));
    dirs.push(dir);
    const one = createSessionInputHoldStore(dir);
    expect(one.hold('session-a', 'action-a')).toBe(true);
    expect(createSessionInputHoldStore(dir).isHeld('session-a')).toBe(true);
    expect(one.hold('session-a', 'action-b')).toBe(false);
    expect(one.release('session-a', 'action-b')).toBe(false);
    expect(one.isHeld('session-a')).toBe(true);
    expect(one.release('session-a', 'action-a')).toBe(true);
    expect(one.isHeld('session-a')).toBe(false);
    expect(createSessionInputHoldStore(dir).hold('session-a', 'action-a')).toBe(false);
    expect(one.hold('session-a', 'action-b')).toBe(true);
    expect(one.isHeld('session-a')).toBe(true);
  });

  it('treats a malformed persisted hold as held', () => {
    const dir = mkdtempSync(join(tmpdir(), 'happier-usage-hold-'));
    dirs.push(dir);
    mkdirSync(join(dir, 'session-input-holds'));
    writeFileSync(join(dir, 'session-input-holds', 'session-a.json'), '{broken');
    const store = createSessionInputHoldStore(dir);
    expect(store.isHeld('session-a')).toBe(true);
    expect(store.release('session-a', 'action-a')).toBe(false);
  });

  it('keeps ingress closed while another process changes the hold', () => {
    const dir = mkdtempSync(join(tmpdir(), 'happier-usage-hold-'));
    dirs.push(dir);
    const first = createSessionInputHoldStore(dir);
    expect(first.hold('session-a', 'action-a')).toBe(true);
    expect(first.release('session-a', 'action-a')).toBe(true);

    // A second process owns the short state-transition critical section.
    // Neither an old release nor a new hold may race across its replacement.
    mkdirSync(join(dir, 'session-input-holds', 'session-a.lock'));
    const competing = createSessionInputHoldStore(dir);
    expect(competing.isHeld('session-a')).toBe(true);
    expect(competing.hold('session-a', 'action-b')).toBe(false);
    expect(first.release('session-a', 'action-a')).toBe(false);
    expect(competing.status('session-a')).toEqual({ actionId: 'action-a', held: false });
  });

  it('does not strand a session when a writer dies before the atomic link', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'happier-usage-hold-'));
    dirs.push(dir);
    const first = createSessionInputHoldStore(dir);
    expect(first.hold('session-a', 'action-a')).toBe(true);
    expect(first.release('session-a', 'action-a')).toBe(true);

    const lock = join(dir, 'session-input-holds', 'session-a.lock');
    const child = spawn(process.execPath, ['-e', `
      const fs = require('node:fs');
      fs.writeFileSync(process.argv[1] + '.staging',
        JSON.stringify({ v: 1, pid: process.pid, token: 'killed-owner-token' }));
      process.stdout.write('ready\\n');
      setInterval(() => {}, 1000);
    `, lock], { stdio: ['ignore', 'pipe', 'pipe'] });
    try {
      await once(child.stdout!, 'data');
      expect(first.isHeld('session-a')).toBe(false);
      child.kill('SIGKILL');
      await once(child, 'exit');
      const second = createSessionInputHoldStore(dir);
      expect(second.hold('session-a', 'action-b')).toBe(true);
      expect(first.hold('session-a', 'action-c')).toBe(false);
      expect(first.release('session-a', 'action-a')).toBe(false);
      expect(first.status('session-a')).toEqual({ actionId: 'action-b', held: true });
      expect(first.isHeld('session-a')).toBe(true);
    } finally {
      child.kill('SIGKILL');
    }
  });

  it('does not reclaim a lock owned by a live process or an unknown owner', () => {
    const dir = mkdtempSync(join(tmpdir(), 'happier-usage-hold-'));
    dirs.push(dir);
    const lock = join(dir, 'session-input-holds', 'session-a.lock');
    mkdirSync(join(dir, 'session-input-holds'), { recursive: true });
    writeFileSync(lock, JSON.stringify({
      v: 1, pid: process.pid, token: 'living-owner-token',
    }));
    const store = createSessionInputHoldStore(dir);
    expect(store.hold('session-a', 'action-a')).toBe(false);
    expect(store.isHeld('session-a')).toBe(true);
    writeFileSync(lock, '{broken');
    expect(store.hold('session-a', 'action-a')).toBe(false);
    expect(store.isHeld('session-a')).toBe(true);
  });

  it('resumes the same action after a dead writer left an active hold', () => {
    const dir = mkdtempSync(join(tmpdir(), 'happier-usage-hold-'));
    dirs.push(dir);
    const store = createSessionInputHoldStore(dir);
    expect(store.hold('session-a', 'action-a')).toBe(true);
    const lock = join(dir, 'session-input-holds', 'session-a.lock');
    writeFileSync(lock, JSON.stringify({
      v: 1, pid: 2_147_483_647, token: 'dead-owner-token',
    }));
    expect(createSessionInputHoldStore(dir).hold('session-a', 'action-a')).toBe(true);
    expect(store.hold('session-a', 'action-b')).toBe(false);
    expect(store.release('session-a', 'action-a')).toBe(true);
    expect(store.hold('session-a', 'action-b')).toBe(true);
  });

  it('lets only one of two processes claim a recovered session', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'happier-usage-hold-'));
    dirs.push(dir);
    const store = createSessionInputHoldStore(dir);
    expect(store.hold('session-a', 'action-a')).toBe(true);
    expect(store.release('session-a', 'action-a')).toBe(true);
    const lock = join(dir, 'session-input-holds', 'session-a.lock');
    writeFileSync(lock, JSON.stringify({
      v: 1, pid: 2_147_483_647, token: 'dead-owner-token',
    }));
    const source = new URL('./sessionInputHoldStore.ts', import.meta.url).href;
    const script = `
      import { createSessionInputHoldStore } from ${JSON.stringify(source)};
      const held = createSessionInputHoldStore(process.env.HOLD_TEST_DIR)
        .hold('session-a', process.env.HOLD_TEST_ACTION);
      process.stdout.write(JSON.stringify({ held }));
    `;
    const children = ['action-b', 'action-c'].map((action) => spawn(process.execPath,
      ['--import', 'tsx', '--input-type=module', '-e', script], {
        cwd: process.cwd(),
        env: { ...process.env, HOLD_TEST_DIR: dir, HOLD_TEST_ACTION: action },
        stdio: ['ignore', 'pipe', 'pipe'],
      }));
    const outcomes = await Promise.all(children.map(async (child) => {
      let output = '';
      let errors = '';
      child.stdout!.on('data', (chunk: Buffer) => { output += chunk.toString(); });
      child.stderr!.on('data', (chunk: Buffer) => { errors += chunk.toString(); });
      const [code] = await once(child, 'close');
      expect(code, errors).toBe(0);
      return JSON.parse(output) as { held: boolean };
    }));
    expect(outcomes.filter((item) => item.held)).toHaveLength(1);
    expect(store.isHeld('session-a')).toBe(true);
    expect(['action-b', 'action-c']).toContain(store.status('session-a')?.actionId);
  });

  it('recovers an atomically linked lock whose owner was killed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'happier-usage-hold-'));
    dirs.push(dir);
    const store = createSessionInputHoldStore(dir);
    expect(store.hold('session-a', 'action-a')).toBe(true);
    expect(store.release('session-a', 'action-a')).toBe(true);
    const lock = join(dir, 'session-input-holds', 'session-a.lock');
    const child = spawn(process.execPath, ['-e', `
      const fs = require('node:fs');
      const staging = process.argv[1] + '.staging';
      fs.writeFileSync(staging, JSON.stringify({
        v: 1, pid: process.pid, token: 'linked-owner-token',
      }));
      fs.linkSync(staging, process.argv[1]);
      process.stdout.write('linked\\n');
      setInterval(() => {}, 1000);
    `, lock], { stdio: ['ignore', 'pipe', 'pipe'] });
    try {
      await once(child.stdout!, 'data');
      expect(store.isHeld('session-a')).toBe(true);
      child.kill('SIGKILL');
      await once(child, 'exit');
      expect(createSessionInputHoldStore(dir).hold('session-a', 'action-b')).toBe(true);
      expect(store.hold('session-a', 'action-c')).toBe(false);
    } finally {
      child.kill('SIGKILL');
    }
  });
});
