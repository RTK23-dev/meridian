-- Evidence-linked research patterns (P2c; see research/patterns.ts and docs/INTELLIGENCE_ROADMAP.md).
--
-- evidence_refs holds, for each example ad, the transcript segment ids that back the pattern's label. Organization
-- summaries store '[]', so no brand's examples cross a brand boundary.
--
-- A pattern counts the model's labels, which are inferences from the transcript. Rows written before this migration
-- were labelled OBSERVED, copied from the aggregator's old output. The relabel below corrects both tables.

alter table research_patterns add column if not exists evidence_refs text not null default '[]';

update research_patterns set state = 'INFERRED' where state = 'OBSERVED';
update opportunities set research_state = 'INFERRED' where research_state = 'OBSERVED';
