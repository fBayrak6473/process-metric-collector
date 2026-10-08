import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MetricCollector, DEFAULT_INTERVAL_MS } from '../src/index.js';

// A fake clock + timer that is fully under the test's control.
class FakeClock {
  constructor() {
    this.nowMs = 1_700_000_000_000;
    this.pending = []; // { fireAt, fn }
    this.advancing = false;
  }
  now() {
    return this.nowMs;
  }
  // Advances virtual time, firing any due timers in order, exactly once each.
  // Does not recurse: a callback that schedules a new timer must be advanced
  // by a subsequent call.
  advance(ms) {
    const target = this.nowMs + ms;
    this.nowMs = target;
    const due = this.pending.filter((t) => t.fireAt <= target && t.fn);
    this.pending = this.pending.filter((t) => t.fireAt > target || !t.fn);
    due.sort((a, b) => a.fireAt - b.fireAt);
    for (const t of due) t.fn();
  }
  setTimeout(fn, ms) {
    const handle = { fireAt: this.nowMs + ms, fn, cancelled: false };
    this.pending.push(handle);
    return {
      unref() {},
      _handle: handle,
    };
  }
  cancel(timer) {
    if (timer && timer._handle) timer._handle.fn = null;
  }
}

// Builds a collector wired to a FakeClock so no real timers are used.
function makeCollector({ onReading, intervalMs = 10, memoryUsage, cpuUsage, maxSamples } = {}) {
  const clock = new FakeClock();
  const mem = memoryUsage || (() => ({ rss: 1000, heapTotal: 500, heapUsed: 250, external: 50 }));
  const cpu = cpuUsage || (() => ({ user: 0, system: 0 }));
  const collector = new MetricCollector(onReading || (() => {}), {
    intervalMs,
    now: clock.now.bind(clock),
    memoryUsage: mem,
    cpuUsage: cpu,
    maxSamples,
  });
  // Monkey-patch the private scheduler to use the fake clock. This keeps the
  // production code free of test hooks while making tests deterministic.
  collector._schedule = function () {
    this._timer = clock.setTimeout(() => this._tick(), this._intervalMs);
    if (this._timer && typeof this._timer.unref === 'function') {
      this._timer.unref();
    }
  };
  // Also patch stop() to cancel via the fake clock so cancelled timers do not
  // fire on a later advance().
  const originalStop = collector.stop.bind(collector);
  collector.stop = function () {
    clock.cancel(this._timer);
    this._timer = null;
    return originalStop();
  };
  return { collector, clock };
}

test('exports the expected names', () => {
  assert.equal(typeof MetricCollector, 'function');
  assert.equal(typeof DEFAULT_INTERVAL_MS, 'number');
});

test('default interval is 1000ms', () => {
  assert.equal(DEFAULT_INTERVAL_MS, 1000);
});

test('emits one reading per interval tick', () => {
  const readings = [];
  const { collector, clock } = makeCollector({ onReading: (r) => readings.push(r), intervalMs: 10 });
  collector.start();
  clock.advance(10);
  assert.equal(readings.length, 1);
  clock.advance(10);
  assert.equal(readings.length, 2);
  collector.stop();
});

test('timestamp comes from the injected clock', () => {
  const readings = [];
  const { collector, clock } = makeCollector({ onReading: (r) => readings.push(r), intervalMs: 5 });
  const before = clock.now();
  collector.start();
  clock.advance(5);
  assert.equal(readings[0].timestamp, before + 5);
  collector.stop();
});

test('memory fields are forwarded from the source', () => {
  const readings = [];
  const fixedMemory = {
    rss: 1111, heapTotal: 2222, heapUsed: 3333, external: 4444, arrayBuffers: 5555,
  };
  const { collector, clock } = makeCollector({
    onReading: (r) => readings.push(r),
    memoryUsage: () => fixedMemory,
  });
  collector.start();
  clock.advance(10);
  assert.deepEqual(readings[0].memory, fixedMemory);
  collector.stop();
});

test('arrayBuffers is omitted when the runtime does not provide it', () => {
  const readings = [];
  const { collector, clock } = makeCollector({
    onReading: (r) => readings.push(r),
    memoryUsage: () => ({ rss: 1, heapTotal: 2, heapUsed: 3, external: 4 }),
  });
  collector.start();
  clock.advance(10);
  assert.equal('arrayBuffers' in readings[0].memory, false);
  collector.stop();
});

test('cpu is the delta between two samples', () => {
  const readings = [];
  let user = 1000;
  let system = 2000;
  const { collector, clock } = makeCollector({
    onReading: (r) => readings.push(r),
    cpuUsage: () => ({ user, system }),
  });
  collector.start(); // takes initial sample (1000, 2000)
  user += 300; system += 500;
  clock.advance(10); // first tick: delta (300, 500)
  assert.deepEqual(readings[0].cpu, { user: 300, system: 500 });
  user += 150; system += 250;
  clock.advance(10); // second tick: delta (150, 250)
  assert.deepEqual(readings[1].cpu, { user: 150, system: 250 });
  collector.stop();
});

test('stop halts further emissions', () => {
  const readings = [];
  const { collector, clock } = makeCollector({ onReading: (r) => readings.push(r) });
  collector.start();
  clock.advance(10);
  collector.stop();
  clock.advance(10);
  clock.advance(10);
  assert.equal(readings.length, 1);
});

test('stop is safe when not running', () => {
  const collector = new MetricCollector(() => {}, { intervalMs: 10 });
  assert.doesNotThrow(() => collector.stop());
});

test('start throws when already running', () => {
  const { collector, clock } = makeCollector();
  collector.start();
  assert.throws(() => collector.start(), /already running/);
  collector.stop();
  clock.advance(10);
});

test('can be restarted after stop', () => {
  const readings = [];
  const { collector, clock } = makeCollector({ onReading: (r) => readings.push(r) });
  collector.start();
  clock.advance(10);
  collector.stop();
  collector.start();
  clock.advance(10);
  assert.equal(readings.length, 2);
  collector.stop();
});

test('emitted counter resets on each start', () => {
  const { collector, clock } = makeCollector();
  collector.start();
  clock.advance(10);
  clock.advance(10);
  assert.equal(collector.emitted, 2);
  collector.stop();
  collector.start();
  assert.equal(collector.emitted, 0);
  clock.advance(10);
  assert.equal(collector.emitted, 1);
  collector.stop();
});

test('maxSamples stops the collector after the limit', () => {
  const readings = [];
  const { collector, clock } = makeCollector({
    onReading: (r) => readings.push(r),
    maxSamples: 2,
  });
  collector.start();
  clock.advance(10);
  clock.advance(10);
  clock.advance(10);
  assert.equal(readings.length, 2);
  assert.equal(collector.running, false);
});

test('callback that calls stop synchronously does not reschedule', () => {
  const readings = [];
  let collector;
  const clock = new FakeClock();
  collector = new MetricCollector((r) => {
    readings.push(r);
    collector.stop();
  }, {
    intervalMs: 10,
    now: clock.now.bind(clock),
    memoryUsage: () => ({ rss: 1, heapTotal: 2, heapUsed: 3, external: 4 }),
    cpuUsage: () => ({ user: 0, system: 0 }),
  });
  collector._schedule = function () {
    this._timer = clock.setTimeout(() => this._tick(), this._intervalMs);
    if (this._timer && typeof this._timer.unref === 'function') this._timer.unref();
  };
  const origStop = collector.stop.bind(collector);
  collector.stop = function () {
    clock.cancel(this._timer);
    this._timer = null;
    return origStop();
  };
  collector.start();
  clock.advance(10);
  clock.advance(10);
  assert.equal(readings.length, 1);
});

test('constructor rejects non-function callback', () => {
  assert.throws(() => new MetricCollector(null), /onReading must be a function/);
  assert.throws(() => new MetricCollector('nope'), /onReading must be a function/);
});

test('constructor rejects invalid intervalMs', () => {
  assert.throws(() => new MetricCollector(() => {}, { intervalMs: 0 }), /positive finite/);
  assert.throws(() => new MetricCollector(() => {}, { intervalMs: -1 }), /positive finite/);
  assert.throws(() => new MetricCollector(() => {}, { intervalMs: NaN }), /positive finite/);
  assert.throws(() => new MetricCollector(() => {}, { intervalMs: Infinity }), /positive finite/);
});

test('constructor rejects invalid maxSamples', () => {
  assert.throws(() => new MetricCollector(() => {}, { maxSamples: -1 }), /non-negative finite/);
  assert.throws(() => new MetricCollector(() => {}, { maxSamples: 1.5 }), /non-negative finite/);
});

test('constructor rejects non-object options', () => {
  assert.throws(() => new MetricCollector(() => {}, 42), /options must be an object/);
  assert.throws(() => new MetricCollector(() => {}, []), /options must be an object/);
});
