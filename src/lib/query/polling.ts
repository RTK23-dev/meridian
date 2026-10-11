/**
 * Refresh rules for the screens that show work in progress. Pure: the hooks pass the cached data in and use the answer as
 * the query's refetch interval, so the rule can be tested without React.
 */

/** Screens refresh every 5 seconds while a job they show is queued, retrying, or running. */
export const ACTIVE_POLL_MS = 5_000;

export const ACTIVE_JOB_STATUSES: ReadonlySet<string> = new Set(["queued", "running", "retry"]);

/** True for a job status that may still change on its own. Finished, failed and cancelled jobs are not active. */
export function isActiveJobStatus(status: string): boolean {
  return ACTIVE_JOB_STATUSES.has(status);
}

/** The jobs list polls while any row on the page is active. A missing list (not loaded yet) never polls. */
export function jobsRefetchInterval(data: { jobs: readonly { status: string }[] } | undefined): number | false {
  return data?.jobs.some((job) => isActiveJobStatus(job.status)) ? ACTIVE_POLL_MS : false;
}

/** The job drawer polls while its one job is active. */
export function jobDetailRefetchInterval(data: { status: string } | undefined): number | false {
  return data && isActiveJobStatus(data.status) ? ACTIVE_POLL_MS : false;
}
