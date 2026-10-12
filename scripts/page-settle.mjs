/**
 * Waits for the page's finite CSS animations to finish before an accessibility scan. An entrance fades text in from opacity 0,
 * so a scan that lands mid-fade measures a blend of the text and the background, not the colour a person sees. Infinite
 * animations never finish, so they are left out. The loop re-checks, because an element can mount and start an animation
 * after the first check. The wait is capped, so a stuck animation cannot hang the run.
 */
export async function settleAnimations(page, timeoutMs = 5000) {
  await page.evaluate(async (limit) => {
    const deadline = Date.now() + limit;
    while (Date.now() < deadline) {
      const pending = document.getAnimations().filter((animation) => animation.playState === "running" && animation.effect?.getTiming().iterations !== Infinity);
      if (!pending.length) return;
      await Promise.race([
        Promise.all(pending.map((animation) => animation.finished.catch(() => undefined))),
        new Promise((resolve) => setTimeout(resolve, Math.max(deadline - Date.now(), 0))),
      ]);
    }
  }, timeoutMs);
}
