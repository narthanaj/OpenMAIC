import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher, type Dispatcher } from 'undici';
import { postWebhook } from '@/jobs/webhook.js';

// Webhook delivery must:
//   - succeed on 2xx (one attempt, ok=true)
//   - retry on 5xx / 429 / 408 with exp backoff — up to 4 attempts total
//   - give up on non-retryable 4xx (not 408/429) after the first attempt
//   - tolerate network errors and retry them
//
// We pass `backoffsMs: [0, 0, 0]` to the postWebhook calls to skip real delays,
// and undici MockAgent to intercept outbound requests without touching the network.

const FAST = { backoffsMs: [0, 0, 0] as const };

describe('postWebhook', () => {
  let agent: MockAgent;
  let prevDispatcher: Dispatcher;

  beforeEach(() => {
    prevDispatcher = getGlobalDispatcher();
    agent = new MockAgent();
    agent.disableNetConnect();
    setGlobalDispatcher(agent);
  });

  afterEach(async () => {
    setGlobalDispatcher(prevDispatcher);
    await agent.close();
  });

  it('returns ok on first-try 200', async () => {
    agent
      .get('http://hook.example')
      .intercept({ path: '/', method: 'POST' })
      .reply(200, { received: true });

    const result = await postWebhook('http://hook.example/', { jobId: 'j1', status: 'done' }, FAST);
    expect(result.ok).toBe(true);
    expect(result.attempts).toBe(1);
    expect(result.lastStatus).toBe(200);
  });

  it('retries 5xx and succeeds on later attempt', async () => {
    const pool = agent.get('http://hook.example');
    pool.intercept({ path: '/', method: 'POST' }).reply(502, '');
    pool.intercept({ path: '/', method: 'POST' }).reply(502, '');
    pool.intercept({ path: '/', method: 'POST' }).reply(200, '');

    const result = await postWebhook('http://hook.example/', { jobId: 'j1', status: 'done' }, FAST);
    expect(result.ok).toBe(true);
    expect(result.attempts).toBe(3);
  });

  it('gives up on non-retryable 4xx after one attempt', async () => {
    agent
      .get('http://hook.example')
      .intercept({ path: '/', method: 'POST' })
      .reply(400, 'bad request');

    const result = await postWebhook('http://hook.example/', { jobId: 'j1', status: 'done' }, FAST);
    expect(result.ok).toBe(false);
    expect(result.attempts).toBe(1);
    expect(result.lastStatus).toBe(400);
  });

  it('retries on 429 rate-limit', async () => {
    const pool = agent.get('http://hook.example');
    pool.intercept({ path: '/', method: 'POST' }).reply(429, '');
    pool.intercept({ path: '/', method: 'POST' }).reply(200, '');

    const result = await postWebhook('http://hook.example/', { jobId: 'j1', status: 'done' }, FAST);
    expect(result.ok).toBe(true);
    expect(result.attempts).toBe(2);
  });

  it('returns ok=false with failure metadata after all retries exhausted', async () => {
    const pool = agent.get('http://hook.example');
    // 4 total attempts (1 initial + 3 retries from BACKOFFS_MS length 3)
    for (let i = 0; i < 4; i++) {
      pool.intercept({ path: '/', method: 'POST' }).reply(503, '');
    }
    const result = await postWebhook('http://hook.example/', { jobId: 'j1', status: 'done' }, FAST);
    expect(result.ok).toBe(false);
    expect(result.attempts).toBe(4);
    expect(result.lastStatus).toBe(503);
  });
});
