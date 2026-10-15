import { useState } from "react";
import { PublishDialog, type PublishTarget, type PublishTrial } from "@/components/studio/publish-dialog";
import type { PublishReceipt } from "@/components/studio/types";
import { publishMultiChannelVariant } from "@/lib/meridian/distribution/actions";
import { useDistributionChannelsQuery, useScopedMutation } from "@/lib/query/hooks";
import { qk } from "@/lib/query/keys";

/**
 * Publishes one stored creative from the Library to any destination that is connected: regular posts, paid ads, or both.
 * It uses Studio's dialog and the same publish action, so both screens offer the same choices and show the same receipts.
 * Each opening is a fresh mount (the parent keys it), so an earlier run's receipts never carry over to the next creative.
 */
export function PublishCreativeDialog({ brandId, target, onClose }: { brandId: string; target: PublishTarget; onClose: () => void }) {
  const channelsQuery = useDistributionChannelsQuery(brandId);
  const [results, setResults] = useState<PublishReceipt[] | null>(null);
  const publish = useScopedMutation({
    mutationKey: ["mutation", "library.publish"],
    mutationFn: (vars: { creativeId: string; channelIds: string[]; caption: string; trial: PublishTrial }) =>
      publishMultiChannelVariant({ data: { brandId, ...vars } }),
    invalidate: () => [qk.library(brandId), qk.studio(brandId), qk.organic(brandId)],
    success: "Publish finished. The receipts are in the dialog.",
    onSuccess: (receipts) => setResults(receipts as PublishReceipt[]),
  });

  return (
    <PublishDialog
      target={target}
      channels={channelsQuery.data ?? []}
      pending={publish.isPending}
      results={results}
      onClose={onClose}
      onConfirm={(channelIds, caption, trial) => {
        void publish.mutateAsync({ creativeId: target.creativeId, channelIds, caption, trial }).catch(() => undefined);
      }}
    />
  );
}
