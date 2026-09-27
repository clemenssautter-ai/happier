import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
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
});
