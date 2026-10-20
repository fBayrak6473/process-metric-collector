# Process Metric Collector

Polls `process.memoryUsage()` and `process.cpuUsage()` at a fixed interval and emits each sample as a structured event to a callback. Zero dependencies, ESM only.

## Usage

```js
import { MetricCollector } from 'process-metric-collector';

const collector = new MetricCollector((reading) => {
  console.log(reading.timestamp, reading.memory.heapUsed, reading.cpu.user);
}, { intervalMs: 1000 });

collector.start();
// later:
collector.stop();
```

Exports:
- `MetricCollector` — the class.
- `DEFAULT_INTERVAL_MS` — `1000`.

`MetricCollector(onReading, options?)` where `options` may contain `intervalMs`, `maxSamples` (stop after N readings, 0 = unbounded), `now`, `memoryUsage`, and `cpuUsage`. The last three default to the Node built-ins and exist so tests can inject deterministic sources.

Each reading has the shape `{ timestamp: number, memory: {...}, cpu: { user, system } }` where `cpu` is the **delta** of `process.cpuUsage()` across the interval (microseconds), and `memory` mirrors `process.memoryUsage()`. `memory.arrayBuffers` is included only when the runtime provides it.

## Why

The problem is observing a Node process's own resource usage over time without pulling in a metrics SDK that brings transports, serialization formats, and a dependency tree. This library is the smallest useful thing: a timer, two `process` calls, a delta, a callback. The trade-off is that you get raw numbers and no aggregation, storage, or export — you wire those up yourself or not at all.

## The awkward edge

The first emitted `cpu` reading is a delta measured from `start()` to the first tick, not from process boot. Because `start()` takes its initial sample immediately and the first timer fires one interval later, the first `cpu` value reflects exactly one interval under normal scheduling. If you call `start()` and then do heavy synchronous work before returning to the event loop, that work shows up in the first reading. This is intentional — it is what makes the first reading meaningful — but it surprises people who expect the first tick to be zero or to cover only time since the previous sample.

Timers are `unref()`'d so the collector will not keep a process alive on its own. If you need it to keep the loop alive, hold a reference to something else that does.

## Design notes

The window stores values eagerly rather than keeping running aggregates. Running
sums drift with floating point over long streams, and recomputing from a small
buffer is cheap enough that the drift is not worth the speed.

