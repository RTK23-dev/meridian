// The per-call decision cap the recorded decision tests run with. A workspace's cap is saved on the Billing page, and an unset cap refuses
// every OpenRouter decision (no precoded caps). The tests give their engine this cap explicitly, so each test states the limit it runs under.
export const recordedDecisionCap = async (): Promise<number | null> => 0.05;
