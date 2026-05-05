import { describe, expect, it } from 'vitest';
import { Envelope } from '../../src/core/apu/envelope';

describe('Envelope', () => {
  it('constant-volume mode outputs `volumeReload` directly', () => {
    const e = new Envelope();
    e.constant = true;
    e.volumeReload = 7;
    expect(e.output()).toBe(7);
  });

  it('decay mode loads decay=15 on the first tick after trigger', () => {
    const e = new Envelope();
    e.volumeReload = 5;
    e.trigger();
    expect(e.output()).toBe(0);
    e.tick(); // first tick: load decay=15, divider=5
    expect(e.output()).toBe(15);
  });

  it('decay counts down once per `volumeReload + 1` ticks', () => {
    const e = new Envelope();
    e.volumeReload = 2; // divider runs 2..1..0..2.. so 3 ticks per decrement
    e.trigger();
    e.tick(); // load: decay=15, divider=2
    expect(e.output()).toBe(15);
    // Three ticks take divider 2->1->0->reload, decrementing decay once.
    e.tick(); e.tick(); e.tick();
    expect(e.output()).toBe(14);
  });

  it('decay stops at 0 when loop is off', () => {
    const e = new Envelope();
    e.volumeReload = 0; // divider reloads every tick → decrement every tick
    e.trigger();
    e.tick(); // load: decay=15
    for (let i = 0; i < 30; i++) e.tick();
    expect(e.output()).toBe(0);
  });

  it('decay loops back to 15 when loop is set', () => {
    const e = new Envelope();
    e.volumeReload = 0;
    e.loop = true;
    e.trigger();
    e.tick(); // load: decay=15
    for (let i = 0; i < 16; i++) e.tick(); // 15 decrements + 1 wrap
    expect(e.output()).toBe(15);
  });
});
