import { test } from 'node:test';
import assert from 'node:assert/strict';
import axios from 'axios';

import {
  validateProxyUrl,
  getProxyValidationMetrics,
  resetProxyValidationState,
} from '../src/network/proxyValidator.js';

test('validateProxyUrl dedupes concurrent checks per proxy', async () => {
  resetProxyValidationState();
  const originalGet = axios.get;
  let calls = 0;

  axios.get = async () => {
    calls += 1;
    await new Promise((resolve) => setTimeout(resolve, 20));
    return { data: { ip: '203.0.113.1', org: 'ExampleNet' } } as any;
  };

  try {
    const proxyUrl = 'http://dedupe-proxy.test:8080';

    const [first, second] = await Promise.all([
      validateProxyUrl(proxyUrl),
      validateProxyUrl(proxyUrl),
    ]);

    assert.equal(calls, 1, 'should perform only one HTTP check for identical concurrent requests');
    assert.deepEqual(first, second, 'both callers should receive the same validation result');
    assert.equal(first.status, 'ok');
    assert.equal(first.ip, '203.0.113.1');
  } finally {
    axios.get = originalGet;
  }
});

test('proxy validation metrics track ok/blocked/fail and average latency', async () => {
  resetProxyValidationState();
  const originalGet = axios.get;
  let call = 0;

  const timeline: number[] = [];
  const originalNow = Date.now;
  Date.now = () => {
    if (timeline.length === 0) return 1_000;
    return timeline.shift() ?? originalNow();
  };

  axios.get = async () => {
    call += 1;
    // Simula latência de 50ms por chamada
    timeline.push((timeline[0] || 1_000) + 50);
    const org = call === 2 ? 'Amazon' : 'Residencial ISP';
    return { data: { ip: `198.51.100.${call}`, org } } as any;
  };

  try {
    await validateProxyUrl('http://ok.test:8080');
    await validateProxyUrl('http://blocked.test:8080');
    const metrics = getProxyValidationMetrics();
    assert.equal(metrics.total, 2);
    assert.equal(metrics.ok, 1);
    assert.equal(metrics.blocked, 1);
    assert.equal(metrics.failed, 0);
    assert.equal(metrics.avgLatencyMs, 50);
    assert.ok(metrics.lastError?.includes('proxy_blocked_datacenter') || metrics.lastError === null);
  } finally {
    axios.get = originalGet;
    Date.now = originalNow;
  }
});
