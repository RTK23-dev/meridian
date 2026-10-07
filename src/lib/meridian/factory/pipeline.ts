/** Factory stages on the existing durable SQL job queue. */

export const FACTORY_STAGES = [
  "factory.discover",
  "factory.ingest",
  "factory.decode",
  "factory.grade",
  "factory.trend",
  "factory.pick",
  "factory.template",
  "factory.produce",
  "factory.gate",
  "factory.review",
  "factory.launch",
  "factory.test",
  "factory.learn",
] as const;

export type FactoryStage = (typeof FACTORY_STAGES)[number];

export type FactoryStageSpec = {
  type: FactoryStage;
  label: string;
  pool: "light" | "media";
  maxAttempts: number;
  dependsOn: FactoryStage | null;
};

export const FACTORY_GRAPH: FactoryStageSpec[] = [
  { type: "factory.discover", label: "Discover sources and trend feeds", pool: "light", maxAttempts: 5, dependsOn: null },
  { type: "factory.ingest", label: "Ingest ads, video, metadata", pool: "media", maxAttempts: 5, dependsOn: "factory.discover" },
  { type: "factory.decode", label: "Decode Creative DNA", pool: "media", maxAttempts: 3, dependsOn: "factory.ingest" },
  { type: "factory.grade", label: "Grade Winner Score", pool: "light", maxAttempts: 3, dependsOn: "factory.decode" },
  { type: "factory.trend", label: "Cluster concepts and momentum", pool: "light", maxAttempts: 3, dependsOn: "factory.grade" },
  { type: "factory.pick", label: "Pick what to make next", pool: "light", maxAttempts: 3, dependsOn: "factory.trend" },
  { type: "factory.template", label: "Storyboard from a winner", pool: "light", maxAttempts: 3, dependsOn: "factory.pick" },
  { type: "factory.produce", label: "Produce variants for your product", pool: "media", maxAttempts: 3, dependsOn: "factory.template" },
  { type: "factory.gate", label: "Originality, brand, claims, policy", pool: "light", maxAttempts: 3, dependsOn: "factory.produce" },
  { type: "factory.review", label: "Approve or edit", pool: "light", maxAttempts: 3, dependsOn: "factory.gate" },
  { type: "factory.launch", label: "Upload paused, then capped spend", pool: "light", maxAttempts: 5, dependsOn: "factory.review" },
  { type: "factory.test", label: "Shift budget to winners", pool: "light", maxAttempts: 5, dependsOn: "factory.launch" },
  { type: "factory.learn", label: "Calibrate every score", pool: "light", maxAttempts: 3, dependsOn: "factory.test" },
];

export type FactoryJobDraft = {
  jobType: FactoryStage;
  idempotencyKey: string;
  payload: Record<string, unknown>;
  maxAttempts: number;
  dependsOnKey: string | null;
  pool: "light" | "media";
  priority: number;
};

export function factoryRunJobs(input: {
  organizationId: string;
  brandId: string;
  runId: string;
  niche: string;
}): FactoryJobDraft[] {
  const org = input.organizationId.trim();
  const brand = input.brandId.trim();
  const run = input.runId.trim();
  if (!org || !brand || !run) throw new Error("A factory run needs an organization, brand, and run id.");
  const niche = input.niche.trim().slice(0, 80);
  return FACTORY_GRAPH.map((stage, index) => ({
    jobType: stage.type,
    idempotencyKey: `factory:${brand}:${run}:${stage.type}`,
    payload: {
      organizationId: org,
      brandId: brand,
      runId: run,
      niche,
      stage: stage.type,
    },
    maxAttempts: stage.maxAttempts,
    dependsOnKey: stage.dependsOn ? `factory:${brand}:${run}:${stage.dependsOn}` : null,
    pool: stage.pool,
    priority: 20 + index,
  }));
}

export function isFactoryStage(value: string): value is FactoryStage {
  return (FACTORY_STAGES as readonly string[]).includes(value);
}
