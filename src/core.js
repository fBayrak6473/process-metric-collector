/**
 * MetricCollector polls Node.js process resource usage at a fixed interval
 * and emits structured readings to a callback.
 *
 * Design choices:
 * - The interval is driven by setTimeout chained calls, not setInterval, so
 *   that drift from the callback's own execution time does not accumulate.
 * - cpuUsage is a delta between two absolute samples. The collector takes an
 *   initial sample at start() so the first emitted reading reflects usage
 *   *during* the first interval, not since process boot. This is the edge
 *   users trip on: the first event carries a cpu delta measured from start()
 *   to the first tick, which is a fraction of the interval if start() and the
 *   timer fire close together.
 * - All time is taken from a `now` function (defaults to Date.now) so tests
 *   can inject a deterministic clock. We never assert on wall clock in tests.
 * - Memory fields are taken straight from process.memoryUsage(); rss, heapTotal,
 *   heapUsed, external, and arrayBuffers (when present on the runtime).
 */

export const DEFAULT_INTERVAL_MS = 1000;

const isObject = (v) =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * @typedef {Object} MemoryReading
 * @property {number} rss
 * @property {number} heapTotal
 * @property {number} heapUsed
 * @property {number} external
 * @property {number} [arrayBuffers]
 */

/**
 * @typedef {Object} CpuReading
 * @property {number} user Microseconds of user CPU time in this interval.
 * @property {number} system Microseconds of system CPU time in this interval.
 */

/**
 * @typedef {Object} MetricReading
 * @property {number} timestamp Epoch milliseconds from the injected `now`.
 * @property {MemoryReading} memory
 * @property {CpuReading} cpu
 */

export class MetricCollector {
  /**
   * @param {(reading: MetricReading) => void} onReading Called for each sample.
   * @param {Object} [options]
   * @param {number} [options.intervalMs] Polling interval in milliseconds.
   * @param {() => number} [options.now] Returns current epoch ms.
   * @param {() => NodeJS.MemoryUsage} [options.memoryUsage] Override memory source.
   * @param {() => NodeJS.CpuUsage} [options.cpuUsage] Override cpu source.
   * @param {number} [options.maxSamples] Stop after N readings. 0 = unbounded.
   */
  constructor(onReading, options = {}) {
    if (typeof onReading !== 'function') {
      throw new TypeError('onReading must be a function');
    }
    if (!isObject(options)) {
      throw new TypeError('options must be an object');
    }

    const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
    if (typeof intervalMs !== 'number' || !Number.isFinite(intervalMs) || intervalMs <= 0) {
      throw new RangeError('intervalMs must be a positive finite number');
    }

    const maxSamples = options.maxSamples ?? 0;
    if (typeof maxSamples !== 'number' || !Number.isInteger(maxSamples) || maxSamples < 0) {
      throw new RangeError('maxSamples must be a non-negative finite integer');
    }

    this._onReading = onReading;
    this._intervalMs = intervalMs;
    this._now = typeof options.now === 'function' ? options.now : Date.now;
    this._memoryUsage =
      typeof options.memoryUsage === 'function' ? options.memoryUsage : () => process.memoryUsage();
    this._cpuUsage =
      typeof options.cpuUsage === 'function' ? options.cpuUsage : () => process.cpuUsage();
    this._maxSamples = maxSamples;

    this._timer = null;
    this._started = false;
    this._emitted = 0;
    this._lastCpu = null;
  }

  /** True while the collector has an active polling loop. */
  get running() {
    return this._started;
  }

  /** Number of readings emitted since start(). Reset by start(). */
  get emitted() {
    return this._emitted;
  }

  /**
   * Begins polling. Takes the initial cpu sample immediately so the first
   * emitted delta covers the first interval.
   *
   * @throws {Error} If already running.
   */
  start() {
    if (this._started) throw new Error('Collector already running');
    this._started = true;
    this._emitted = 0;
    this._lastCpu = this._cpuUsage();
    this._schedule();
  }

  /**
   * Stops the polling loop. Safe to call when not running. Returns the number
   * of readings emitted during this run.
   *
   * @returns {number}
   */
  stop() {
    if (this._timer !== null) {
      clearTimeout(this._timer);
      this._timer = null;
    }
    this._started = false;
    this._lastCpu = null;
    return this._emitted;
  }

  _schedule() {
    this._timer = setTimeout(() => this._tick(), this._intervalMs);
    // Refuse to keep the event loop alive solely for this collector. This
    // lets a process exit naturally if nothing else is pending, which is
    // usually the desired behaviour for a passive observer.
    if (this._timer && typeof this._timer.unref === 'function') {
      this._timer.unref();
    }
  }

  _tick() {
    this._timer = null;

    const currentCpu = this._cpuUsage();
    const last = this._lastCpu;
    this._lastCpu = currentCpu;

    const cpu = last
      ? { user: currentCpu.user - last.user, system: currentCpu.system - last.system }
      : { user: 0, system: 0 };

    const mem = this._memoryUsage();
    const memory = {
      rss: mem.rss,
      heapTotal: mem.heapTotal,
      heapUsed: mem.heapUsed,
      external: mem.external,
    };
    if (typeof mem.arrayBuffers === 'number') {
      memory.arrayBuffers = mem.arrayBuffers;
    }

    /** @type {MetricReading} */
    const reading = {
      timestamp: this._now(),
      memory,
      cpu,
    };

    this._emitted += 1;

    let shouldStop = !this._started;
    if (this._maxSamples > 0 && this._emitted >= this._maxSamples) {
      shouldStop = true;
    }

    // Emit after updating counters but before deciding to reschedule, so a
    // synchronous stop() inside the callback is respected and a thrown error
    // does not silently kill the loop while the timer is still "live" in
    // the caller's mind.
    this._onReading(reading);

    if (!this._started) {
      shouldStop = true;
    }

    if (shouldStop) {
      this._started = false;
      this._lastCpu = null;
      return;
    }

    this._schedule();
  }
}
