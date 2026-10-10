import { useCallback, useMemo, useState } from "react";
import { DEFAULT_RESEARCH_FILTERS, activeFilterCount, filterResearchAds, topicOptions, type ResearchAdRow, type ResearchFilters } from "./research-model";

/** Filter state for the analysed-ads list. The matching rules live in research-model.ts so they can be tested directly. */
export function useResearchFilters(ads: readonly ResearchAdRow[]) {
  const [filters, setFilters] = useState<ResearchFilters>(DEFAULT_RESEARCH_FILTERS);
  const visible = useMemo(() => filterResearchAds(ads, filters), [ads, filters]);
  const topics = useMemo(() => topicOptions(ads), [ads]);
  const update = useCallback(<Key extends keyof ResearchFilters>(key: Key, value: ResearchFilters[Key]) => {
    setFilters((current) => ({ ...current, [key]: value }));
  }, []);
  const reset = useCallback(() => setFilters(DEFAULT_RESEARCH_FILTERS), []);
  return { filters, update, reset, visible, topics, activeCount: activeFilterCount(filters) };
}
