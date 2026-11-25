'use strict';

const DEFAULT_SAMPLE_INTERVAL_MS = 60_000;
const DEFAULT_ACTIVE_SESSION_SAMPLE_INTERVAL_MS = 10_000;
const DEFAULT_MINIMUM_ACTIVE_RATE_BPS = 10_000;

function createActiveHotspotSampler(
  sampleIntervalMs = DEFAULT_ACTIVE_SESSION_SAMPLE_INTERVAL_MS,
  minimumRateBps = DEFAULT_MINIMUM_ACTIVE_RATE_BPS,
) {
  if (!Number.isSafeInteger(sampleIntervalMs) || sampleIntervalMs < 1) {
    throw new RangeError('The active Hotspot sample interval must be a positive integer.');
  }
  if (!Number.isSafeInteger(minimumRateBps) || minimumRateBps < 1) {
    throw new RangeError('The minimum active Hotspot rate must be a positive integer.');
  }

  let previousCounters = null;
  let previousSampledAt = null;
  let latestSample = {
    count: null,
    countReady: false,
    countSampledAt: null,
  };

  function reset() {
    previousCounters = null;
    previousSampledAt = null;
    latestSample = {
      count: null,
      countReady: false,
      countSampledAt: null,
    };
  }

  function sample(currentCounters, sampledAt = Date.now()) {
    validateCounters(currentCounters, sampledAt);
    if (previousCounters === null) {
      previousCounters = new Map(currentCounters);
      previousSampledAt = sampledAt;
      return { ...latestSample };
    }

    const elapsedMs = sampledAt - previousSampledAt;
    if (elapsedMs < 0) {
      reset();
      previousCounters = new Map(currentCounters);
      previousSampledAt = sampledAt;
      return { ...latestSample };
    }
    if (elapsedMs < sampleIntervalMs) return { ...latestSample };

    let count = 0;
    const elapsed = BigInt(elapsedMs);
    const minimumBits = BigInt(minimumRateBps) * elapsed;
    for (const [sessionKey, current] of currentCounters) {
      const previous = previousCounters.get(sessionKey);
      if (
        !previous
        || current.uploadBytes < previous.uploadBytes
        || current.downloadBytes < previous.downloadBytes
      ) {
        continue;
      }

      const trafficBytes = current.uploadBytes - previous.uploadBytes
        + current.downloadBytes - previous.downloadBytes;
      if (trafficBytes * 8_000n >= minimumBits) count += 1;
    }

    previousCounters = new Map(currentCounters);
    previousSampledAt = sampledAt;
    latestSample = {
      count,
      countReady: true,
      countSampledAt: sampledAt,
    };
    return { ...latestSample };
  }

  return { sample, reset };
}

function validateCounters(currentCounters, sampledAt) {
  if (!(currentCounters instanceof Map)) {
    throw new TypeError('Hotspot traffic counters must be provided as a Map.');
  }
  if (!Number.isSafeInteger(sampledAt)) {
    throw new TypeError('The Hotspot traffic sample time must be a safe integer.');
  }
  for (const [sessionKey, counters] of currentCounters) {
    if (
      typeof sessionKey !== 'string'
      || !counters
      || typeof counters.uploadBytes !== 'bigint'
      || typeof counters.downloadBytes !== 'bigint'
      || counters.uploadBytes < 0n
      || counters.downloadBytes < 0n
    ) {
      throw new TypeError('Hotspot traffic counters have an invalid format.');
    }
  }
}

function createHotspotTrafficSampler(sampleIntervalMs = DEFAULT_SAMPLE_INTERVAL_MS) {
  if (!Number.isSafeInteger(sampleIntervalMs) || sampleIntervalMs < 1) {
    throw new RangeError('The Hotspot traffic sample interval must be a positive integer.');
  }

  let previousCounters = null;
  let windowStartedAt = null;
  let uploadBytes = 0n;
  let downloadBytes = 0n;
  let latestSample = {
    ready: false,
    uploadBps: null,
    downloadBps: null,
    sampledAt: null,
  };

  function reset() {
    previousCounters = null;
    windowStartedAt = null;
    uploadBytes = 0n;
    downloadBytes = 0n;
    latestSample = {
      ready: false,
      uploadBps: null,
      downloadBps: null,
      sampledAt: null,
    };
  }

  function sample(currentCounters, sampledAt = Date.now()) {
    validateCounters(currentCounters, sampledAt);

    if (previousCounters === null) {
      previousCounters = new Map(currentCounters);
      windowStartedAt = sampledAt;
      return { ...latestSample };
    }

    const elapsedMs = sampledAt - windowStartedAt;
    if (elapsedMs < 0) {
      reset();
      previousCounters = new Map(currentCounters);
      windowStartedAt = sampledAt;
      return { ...latestSample };
    }

    for (const [sessionKey, current] of currentCounters) {
      const previous = previousCounters.get(sessionKey);
      if (!previous) continue;
      if (current.uploadBytes >= previous.uploadBytes) {
        uploadBytes += current.uploadBytes - previous.uploadBytes;
      }
      if (current.downloadBytes >= previous.downloadBytes) {
        downloadBytes += current.downloadBytes - previous.downloadBytes;
      }
    }

    previousCounters = new Map(currentCounters);
    if (elapsedMs < sampleIntervalMs) return { ...latestSample };

    const elapsed = BigInt(elapsedMs);
    latestSample = {
      ready: true,
      uploadBps: ((uploadBytes * 8_000n) / elapsed).toString(),
      downloadBps: ((downloadBytes * 8_000n) / elapsed).toString(),
      sampledAt,
    };
    windowStartedAt = sampledAt;
    uploadBytes = 0n;
    downloadBytes = 0n;
    return { ...latestSample };
  }

  return { sample, reset };
}

module.exports = { createActiveHotspotSampler, createHotspotTrafficSampler };
