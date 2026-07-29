import { db, enqueueCohortCompute } from '@openpanel/db';
import { cohortComputeQueue } from '@openpanel/queue';
import { getRedisQueue } from '@openpanel/redis';
import { Worker } from 'bullmq';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';

import { TEST_PROJECT_ID } from '../../../../test/global-setup';
import { cohortRefreshCronJob } from './cron.cohort-refresh';

const COHORT_ID = 'enqueue-regression-test';

async function runPendingJobs(process: () => Promise<void> = async () => {
  // no-op: the compute itself is not under test here
}) {
  const worker = new Worker(cohortComputeQueue.name, process, {
    connection: getRedisQueue(),
  });
  await new Promise<void>((resolve) => {
    worker.on('drained', () => resolve());
  });
  await worker.close();
}

// Drives a job to a terminal failure, skipping the queue's exponential retry
// backoff so the test does not have to wait it out.
async function runUntilFailed() {
  const worker = new Worker(
    cohortComputeQueue.name,
    async () => {
      throw new Error('memory limit exceeded');
    },
    { connection: getRedisQueue() },
  );

  try {
    for (let attempt = 0; attempt < 200; attempt++) {
      if ((await cohortComputeQueue.getFailedCount()) > 0) {
        return;
      }
      const [delayed] = await cohortComputeQueue.getDelayed();
      if (delayed) {
        await delayed.changeDelay(0).catch(() => undefined);
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error('Job never reached a terminal failure');
  } finally {
    await worker.close();
  }
}

describe('enqueueCohortCompute', () => {
  beforeEach(async () => {
    await cohortComputeQueue.obliterate({ force: true });
  });

  afterAll(async () => {
    await cohortComputeQueue.obliterate({ force: true });
  });

  it('enqueues a compute job for the cohort', async () => {
    await enqueueCohortCompute(COHORT_ID);

    expect(await cohortComputeQueue.getWaitingCount()).toBe(1);
  });

  it('re-enqueues once the previous run has finished', async () => {
    await enqueueCohortCompute(COHORT_ID);
    await runPendingJobs();
    expect(await cohortComputeQueue.getCompletedCount()).toBe(1);

    await enqueueCohortCompute(COHORT_ID);

    expect(await cohortComputeQueue.getWaitingCount()).toBe(1);
  });

  it('re-enqueues after a run failed, keeping the failure for inspection', async () => {
    await enqueueCohortCompute(COHORT_ID);
    await runUntilFailed();

    await enqueueCohortCompute(COHORT_ID);

    expect(await cohortComputeQueue.getWaitingCount()).toBe(1);
    const [failed] = await cohortComputeQueue.getFailed();
    expect(failed?.failedReason).toBe('memory limit exceeded');
  });

  it('does not enqueue a duplicate while a run is still waiting', async () => {
    await enqueueCohortCompute(COHORT_ID);
    await enqueueCohortCompute(COHORT_ID);

    expect(await cohortComputeQueue.getWaitingCount()).toBe(1);
  });
});

describe('cohortRefreshCronJob', () => {
  let cohortId: string;

  beforeEach(async () => {
    await cohortComputeQueue.obliterate({ force: true });
    const cohort = await db.cohort.create({
      data: {
        name: 'cron refresh regression test',
        projectId: TEST_PROJECT_ID,
        isStatic: false,
      },
    });
    cohortId = cohort.id;
  });

  afterEach(async () => {
    await db.cohort.delete({ where: { id: cohortId } });
    await cohortComputeQueue.obliterate({ force: true });
  });

  it('enqueues every tick, not only the one following a finished run', async () => {
    await cohortRefreshCronJob();
    expect(await cohortComputeQueue.getWaitingCount()).toBe(1);

    await runPendingJobs();

    // The next tick, 30 minutes later, while the finished job record is still
    // inside its removeOnComplete age window.
    await cohortRefreshCronJob();

    const [queued] = await cohortComputeQueue.getWaiting();
    expect(queued?.data.cohortId).toBe(cohortId);
  });

  it('skips static cohorts', async () => {
    await db.cohort.update({
      where: { id: cohortId },
      data: { isStatic: true },
    });

    await cohortRefreshCronJob();

    expect(await cohortComputeQueue.getWaitingCount()).toBe(0);
  });
});
