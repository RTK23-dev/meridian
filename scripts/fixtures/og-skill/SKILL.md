# Open Graph asset pass (test fixture)

The card pass uses `/workspace/.grok/og-pending` as its in-progress marker.
Treat a marker as stale after 10 minutes.

## Brand-asset pass:

Never affirm a wait: never `wait_tasks`; never `get_task_output`.

Check the generated card with:
`node scripts/brand-check.mjs --game`
