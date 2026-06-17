import type { Job } from 'bullmq';

import type { SessionsQueuePayload } from '@openpanel/queue';

import { logger } from '@/utils/logger';
import {
  db,
  getOrganizationBillingEventsCount,
  getProjectEventsCount,
} from '@openpanel/db';
import { cacheable } from '@openpanel/redis';
import { createSessionEnd } from './events.create-session-end';

export async function sessionsJob(job: Job<SessionsQueuePayload>) {
  const res = await createSessionEnd(job);
  try {
    await updateEventsCount(job.data.payload.projectId);
  } catch (e) {
    logger.error('Failed to update events count', e);
  }
  return res;
}

const updateEventsCount = cacheable(async function updateEventsCount(
  projectId: string,
) {
  const organization = await db.organization.findFirst({
    where: {
      projects: {
        some: {
          id: projectId,
        },
      },
    },
    include: {
      projects: true,
    },
  });

  if (!organization) {
    return;
  }

  // Newton: billing/usage tracking disabled for self-hosted personal use — getOrganization
  // BillingEventsCount full-scans events for the subscription period on every fire and we
  // don't bill. Project eventsCount is kept (now a cheap distinct_event_names_mv pre-agg read).
  // biome-ignore lint/correctness/noConstantCondition: feature flag, original path preserved
  const BILLING_ENABLED = false;
  const organizationEventsCount = BILLING_ENABLED
    ? await getOrganizationBillingEventsCount(organization)
    : 0;
  const projectEventsCount = await getProjectEventsCount(projectId);

  if (projectEventsCount) {
    await db.project.update({
      where: {
        id: projectId,
      },
      data: {
        eventsCount: projectEventsCount,
      },
    });
  }

  if (BILLING_ENABLED && organizationEventsCount) {
    await db.organization.update({
      where: {
        id: organization.id,
      },
      data: {
        subscriptionPeriodEventsCount: organizationEventsCount,
        subscriptionPeriodEventsCountExceededAt:
          organizationEventsCount >
            organization.subscriptionPeriodEventsLimit &&
          !organization.subscriptionPeriodEventsCountExceededAt
            ? new Date()
            : organizationEventsCount <=
                organization.subscriptionPeriodEventsLimit
              ? null
              : organization.subscriptionPeriodEventsCountExceededAt,
      },
    });
  }

  return true;
}, 60 * 60);
