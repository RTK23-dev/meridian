/**
 * The team on the workspace overview: one monogram per agent (DESIGN.md section 7), each in a state read from the workspace's own job
 * counts. Nothing here invents a state. A job type with no agent is not shown, and a count that has not loaded is "checking", not idle.
 */

export type AgentId = "analyst" | "strategist" | "art_director" | "publisher";

export type TeamAgent = {
  id: AgentId;
  name: string;
  monogram: string;
  role: string;
  /** Job types this agent owns: a type belongs to an agent when it equals a prefix or starts with the prefix and a dot. */
  jobPrefixes: readonly string[];
};

export const TEAM: readonly TeamAgent[] = [
  { id: "analyst", name: "Analyst", monogram: "An", role: "Gathers market evidence and measures results", jobPrefixes: ["research", "market", "measurement", "performance", "learning", "telemetry", "embedding", "cluster"] },
  { id: "strategist", name: "Strategist", monogram: "St", role: "Grades opportunities and plans the tests", jobPrefixes: ["opportunity", "experiment"] },
  { id: "art_director", name: "Art director", monogram: "Ad", role: "Makes the ads and checks them", jobPrefixes: ["factory", "video", "creative", "asset", "vision", "production"] },
  { id: "publisher", name: "Publisher", monogram: "Pb", role: "Sends paused ads and posts to the platforms", jobPrefixes: ["publishing", "organic"] },
];

/** One row of the workspace's job counts: the type, its status, and how many jobs. */
export type JobCount = { type: string; status: string; count: number };

export type AgentTone = "checking" | "blocked" | "waiting" | "working" | "queued" | "idle";

export type AgentState = { id: AgentId; name: string; monogram: string; role: string; tone: AgentTone; label: string };

/** Whether a job type belongs to an agent's prefixes. `research.collect` belongs to `research`; `researchers` does not. */
export function ownsJobType(prefixes: readonly string[], jobType: string): boolean {
  return prefixes.some((prefix) => jobType === prefix || jobType.startsWith(`${prefix}.`));
}

function plural(count: number, one: string, many: string): string {
  return count === 1 ? one : many;
}

/**
 * The team's states. `jobs` is null while the counts load. `openReviews` is null while the reviews load, and only the art director waits on
 * reviews. Priority: a failed job (blocked) first, then a review waiting on the person, then running work, then queued work, then idle.
 */
export function teamStates(input: { jobs: JobCount[] | null; openReviews: number | null }): AgentState[] {
  return TEAM.map((agent) => {
    const base = { id: agent.id, name: agent.name, monogram: agent.monogram, role: agent.role };
    if (input.jobs === null) return { ...base, tone: "checking", label: "Checking the team's work" };
    const owned = input.jobs.filter((row) => ownsJobType(agent.jobPrefixes, row.type));
    const count = (status: string[]) => owned.filter((row) => status.includes(row.status)).reduce((total, row) => total + row.count, 0);
    const failed = count(["dead"]);
    const running = count(["running"]);
    const queued = count(["queued", "retry"]);
    const reviews = agent.id === "art_director" ? input.openReviews : null;
    if (failed > 0) return { ...base, tone: "blocked", label: `${failed} ${plural(failed, "job", "jobs")} failed in the last day` };
    if (reviews !== null && reviews > 0) return { ...base, tone: "waiting", label: `${reviews} ${plural(reviews, "review needs", "reviews need")} you` };
    if (running > 0) return { ...base, tone: "working", label: `Working on ${running} ${plural(running, "job", "jobs")}` };
    if (queued > 0) return { ...base, tone: "queued", label: `${queued} ${plural(queued, "job", "jobs")} queued, not started` };
    return { ...base, tone: "idle", label: "Idle. Nothing is queued." };
  });
}
