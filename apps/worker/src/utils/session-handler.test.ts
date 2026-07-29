import type { IServiceCreateEventPayload } from '@openpanel/db';
import { sessionsQueue } from '@openpanel/queue';
import { getRedisQueue } from '@openpanel/redis';
import { Worker } from 'bullmq';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { createSessionEndJob } from './session-handler';

const PROJECT_ID = 'session-handler-test';
const DEVICE_ID = 'device-1';

const payload = {
  projectId: PROJECT_ID,
  deviceId: DEVICE_ID,
} as IServiceCreateEventPayload;

describe('createSessionEndJob', () => {
  beforeEach(async () => {
    await sessionsQueue.obliterate({ force: true });
  });

  afterAll(async () => {
    await sessionsQueue.obliterate({ force: true });
  });

  it('schedules one delayed job per device', async () => {
    await createSessionEndJob({ payload });

    expect(await sessionsQueue.getDelayedCount()).toBe(1);
  });

  it('can schedule again for the same device after every attempt failed', async () => {
    const job = await createSessionEndJob({ payload });
    // Skip the 30 minute session timeout so the job becomes processable.
    await job.changeDelay(0);

    const worker = new Worker(
      sessionsQueue.name,
      async () => {
        throw new Error('boom');
      },
      { connection: getRedisQueue() },
    );
    for (let attempt = 0; attempt < 50; attempt++) {
      if ((await job.getState()) === 'unknown') {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    await worker.close();

    // The terminal record must not survive, otherwise this device could never
    // get a session end job again.
    expect(await sessionsQueue.getJob(job.id!)).toBeUndefined();

    await createSessionEndJob({ payload });

    expect(await sessionsQueue.getDelayedCount()).toBe(1);
  });
});
