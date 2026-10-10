import { useState } from "react";
import { CheckCircle2, Info, Lock } from "lucide-react";
import { Button, Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui";
import type { FactoryComponentId, PipelineStageConfig } from "@/lib/meridian/factory/pipeline-config";
import { FACTORY_LEVEL_LABELS, type FactoryLevel } from "@/lib/meridian/factory/autopilot";
import { minimumLevel } from "@/lib/meridian/factory/pipeline";
import {
  CATEGORY_LABEL,
  STAGE_NOTE,
  STAGE_SETTINGS,
  TAB_LABEL,
  jobForStage,
  jobsWithoutStage,
  stageRun,
  type EditorTab,
} from "./pipeline-model";

function levelText(level: number): string {
  const label = FACTORY_LEVEL_LABELS[level as FactoryLevel];
  return label ? `level ${level} (${label})` : `level ${level}`;
}

/**
 * The saved stage line as cards. Each card names the real factory job behind the stage, or says there is none. The only
 * skip the server applies is the autopilot level, so there is no bypass switch here.
 */
export function StageFlow({
  stages,
  level,
  onOpenTab,
}: {
  stages: PipelineStageConfig[];
  level: number;
  onOpenTab: (tab: EditorTab) => void;
}) {
  const [openId, setOpenId] = useState<FactoryComponentId | null>(null);
  const [isOpen, setIsOpen] = useState(false);
  const openStage = stages.find((stage) => stage.id === openId) ?? null;
  const unmapped = jobsWithoutStage();

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <p className="max-w-3xl text-sm text-fg-muted">
          The saved line lists these stages in order. Each card names the factory job behind it, if one exists. Open a card for its details and the saved settings that feed it.
        </p>
        <p className="max-w-3xl text-sm text-fg-muted">
          There is no per-stage bypass. A run leaves a job out only when the run&apos;s autopilot level is below that job&apos;s minimum. The level is set on the Live tests tab.
        </p>
      </div>

      <ol aria-label="Factory stages" className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {stages.map((stage, index) => {
          const run = stageRun(stage.id, level);
          const job = jobForStage(stage.id);
          return (
            <li key={stage.id}>
              <button
                type="button"
                aria-haspopup="dialog"
                onClick={() => {
                  setOpenId(stage.id);
                  setIsOpen(true);
                }}
                className="flex h-full min-h-11 w-full flex-col gap-3 rounded-lg border border-border bg-surface p-4 text-left shadow-sm transition-colors hover:border-border-strong hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
              >
                <span className="flex items-center justify-between gap-2">
                  <span className="text-xs font-semibold uppercase tracking-widest text-brass">Stage {index + 1}</span>
                  <span className="text-xs text-fg-muted">{CATEGORY_LABEL[stage.category]}</span>
                </span>
                <span className="font-semibold text-fg">{stage.label}</span>
                <span className="text-sm text-fg-muted">
                  {job ? (
                    <>
                      Factory job: {job.label} <code className="font-mono text-xs">{job.type}</code>
                    </>
                  ) : (
                    "No factory job runs this stage yet."
                  )}
                </span>
                <span className="mt-auto flex items-start gap-2 text-sm">
                  {run.kind === "queued" ? (
                    <>
                      <CheckCircle2 aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-success" />
                      <span>Queued at the current {levelText(level)}.</span>
                    </>
                  ) : run.kind === "not_queued" ? (
                    <>
                      <Lock aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-warning" />
                      <span>Skipped at the current {levelText(level)}. Needs level {run.minLevel}.</span>
                    </>
                  ) : (
                    <>
                      <Info aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-fg-muted" />
                      <span className="text-fg-muted">No job to queue.</span>
                    </>
                  )}
                </span>
              </button>
            </li>
          );
        })}
      </ol>

      <section aria-labelledby="factory-jobs-without-card" className="space-y-3 rounded-lg border border-border bg-surface p-4">
        <h3 id="factory-jobs-without-card" className="font-semibold text-fg">Factory jobs with no stage card</h3>
        <p className="text-sm text-fg-muted">These jobs run in the factory but are not part of the stage line above.</p>
        <ul className="space-y-2 text-sm">
          {unmapped.map((job) => (
            <li key={job.type}>
              {job.label} <code className="font-mono text-xs">{job.type}</code> · minimum level {minimumLevel(job.type)}
            </li>
          ))}
        </ul>
      </section>

      <Sheet open={isOpen} onOpenChange={setIsOpen}>
        <SheetContent>
          {openStage ? (
            <StageDrawerBody
              stage={openStage}
              level={level}
              onOpenTab={(tab) => {
                setIsOpen(false);
                onOpenTab(tab);
              }}
              onClose={() => setIsOpen(false)}
            />
          ) : null}
        </SheetContent>
      </Sheet>
    </div>
  );
}

function StageDrawerBody({
  stage,
  level,
  onOpenTab,
  onClose,
}: {
  stage: PipelineStageConfig;
  level: number;
  onOpenTab: (tab: EditorTab) => void;
  onClose: () => void;
}) {
  const run = stageRun(stage.id, level);
  const job = jobForStage(stage.id);
  const settings = STAGE_SETTINGS[stage.id];
  const note = STAGE_NOTE[stage.id];

  return (
    <div className="space-y-5">
      <div className="space-y-1">
        <SheetTitle className="font-display text-2xl text-fg">{stage.label}</SheetTitle>
        <SheetDescription className="text-sm text-fg-muted">
          {job ? `Factory job: ${job.label}.` : "No factory job runs this stage yet."}
        </SheetDescription>
      </div>

      <dl className="grid gap-3 text-sm sm:grid-cols-2">
        <div>
          <dt className="font-semibold text-fg">Category</dt>
          <dd className="text-fg-muted">{CATEGORY_LABEL[stage.category]}</dd>
        </div>
        <div>
          <dt className="font-semibold text-fg">Run status</dt>
          <dd className="text-fg-muted">
            {run.kind === "queued"
              ? `Queued at the current ${levelText(level)}.`
              : run.kind === "not_queued"
                ? `Skipped at the current ${levelText(level)}. Needs level ${run.minLevel}.`
                : "No job to queue."}
          </dd>
        </div>
        {job ? (
          <>
            <div>
              <dt className="font-semibold text-fg">Job type</dt>
              <dd><code className="font-mono text-xs">{job.type}</code></dd>
            </div>
            <div>
              <dt className="font-semibold text-fg">Worker pool</dt>
              <dd className="text-fg-muted">{job.pool === "media" ? "Media pool" : "Light pool"}</dd>
            </div>
            <div>
              <dt className="font-semibold text-fg">Attempts</dt>
              <dd className="text-fg-muted">Up to {job.maxAttempts}</dd>
            </div>
            <div>
              <dt className="font-semibold text-fg">Runs after</dt>
              <dd className="text-fg-muted">
                {job.dependsOn ? <code className="font-mono text-xs">{job.dependsOn}</code> : "Nothing. It is the first job."}
              </dd>
            </div>
          </>
        ) : null}
      </dl>

      <section aria-labelledby="stage-saved-settings" className="space-y-2">
        <h3 id="stage-saved-settings" className="font-semibold text-fg">Saved settings for this stage</h3>
        {settings.length === 0 ? (
          <p className="text-sm text-fg-muted">No saved setting feeds this stage.</p>
        ) : (
          <>
            <p className="text-sm text-fg-muted">No job reads these yet. Change them on the tab named next to each one.</p>
            <ul className="space-y-1">
              {settings.map((setting) => (
                <li key={setting.label} className="flex flex-wrap items-center justify-between gap-2 text-sm">
                  <span>{setting.label}</span>
                  <Button type="button" variant="link" size="sm" onClick={() => onOpenTab(setting.tab)}>
                    {TAB_LABEL[setting.tab]}
                  </Button>
                </li>
              ))}
            </ul>
          </>
        )}
      </section>

      {note ? <p className="text-sm text-fg-muted">{note}</p> : null}

      <div className="flex justify-end">
        <Button type="button" variant="secondary" onClick={onClose}>Close</Button>
      </div>
    </div>
  );
}
