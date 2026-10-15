import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, errorText, Field, Input } from "@/components/ui";
import { useCurrentUser } from "@/lib/auth/use-current-user";
import { userScopedQueryKey } from "@/lib/query/keys";
import {
  connectShopifyStore,
  disconnectShopifyStore,
  getShopifySales,
  type ShopifySalesView,
} from "@/lib/meridian/shopify/actions";
import type { ReelSales } from "@/lib/meridian/shopify/store";

/**
 * Sales by reel: the brand's Shopify shop, whether its secret is saved, the webhook address to paste into Shopify, and the orders
 * attributed to each reel. Every figure is a stored row. A total that is not stored is shown as not stored, never as zero. Shop
 * and reel text is rendered as text, never as HTML.
 */
export function SalesByReelPanel({ brandId, canAdmin }: { brandId: string; canAdmin: boolean }) {
  const user = useCurrentUser();
  const queryClient = useQueryClient();
  const key = userScopedQueryKey(user?.id, ["shopify-sales", brandId]);
  const sales = useQuery({ queryKey: key, queryFn: () => getShopifySales({ data: { brandId } }) });
  const [domain, setDomain] = useState("");
  const connect = useMutation({
    mutationFn: () => connectShopifyStore({ data: { brandId, shopDomain: domain } }),
    onSuccess: () => {
      setDomain("");
      void queryClient.invalidateQueries({ queryKey: key });
    },
  });
  const disconnect = useMutation({
    mutationFn: (shopDomain: string) => disconnectShopifyStore({ data: { brandId, shopDomain } }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: key }),
  });

  return (
    <section aria-labelledby="sales-by-reel-heading" className="space-y-4 rounded-lg border border-border p-4">
      <h2 id="sales-by-reel-heading" className="text-base font-semibold">Sales by reel</h2>
      {sales.isPending ? <p className="text-sm text-muted">Loading sales...</p> : null}
      {sales.error ? <p role="alert" className="text-sm text-danger">{errorText(sales.error)}</p> : null}
      {sales.data ? (
        <SalesBody
          view={sales.data}
          canAdmin={canAdmin}
          domain={domain}
          onDomain={setDomain}
          onConnect={() => connect.mutate()}
          connecting={connect.isPending}
          connectError={connect.error ? errorText(connect.error) : null}
          onDisconnect={(shopDomain) => disconnect.mutate(shopDomain)}
          disconnecting={disconnect.isPending}
        />
      ) : null}
    </section>
  );
}

function SalesBody(props: {
  view: ShopifySalesView;
  canAdmin: boolean;
  domain: string;
  onDomain: (value: string) => void;
  onConnect: () => void;
  connecting: boolean;
  connectError: string | null;
  onDisconnect: (shopDomain: string) => void;
  disconnecting: boolean;
}) {
  const { view } = props;
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  return (
    <div className="space-y-4">
      <div className="space-y-1 text-sm">
        {view.shop ? (
          <p>Connected to {view.shop.shopDomain}. Orders from its webhook are matched to reels.</p>
        ) : (
          <p>No Shopify shop is connected to this brand. Connect one to see orders per reel.</p>
        )}
        {view.secret.state === "usable" ? (
          <p>The Shopify app secret is saved{view.secret.fingerprint ? ` (${view.secret.fingerprint})` : ""}.</p>
        ) : (
          <p className="text-warning">
            Shopify deliveries are refused until the app secret is saved in Settings, under Shopify. {view.secret.reason ?? ""}
          </p>
        )}
        <p className="text-muted">
          Webhook address: {origin}{view.webhookPath}. Topic: orders/create. Format: JSON.
        </p>
      </div>

      {props.canAdmin && !view.shop ? (
        <div className="flex flex-wrap items-end gap-2">
          <Field label="Shop domain" hint="The myshopify.com address, such as your-store.myshopify.com" error={props.connectError ?? undefined}>
            <Input value={props.domain} onChange={(event) => props.onDomain(event.target.value)} placeholder="your-store.myshopify.com" />
          </Field>
          <Button type="button" onClick={props.onConnect} disabled={props.connecting || props.domain.trim() === ""}>
            {props.connecting ? "Connecting..." : "Connect shop"}
          </Button>
        </div>
      ) : null}
      {props.canAdmin && view.shop ? (
        <Button type="button" variant="secondary" onClick={() => props.onDisconnect(view.shop?.shopDomain ?? "")} disabled={props.disconnecting}>
          Disconnect shop
        </Button>
      ) : null}

      {view.sales.reels.length === 0 ? (
        <p className="text-sm text-muted">No reel has a link yet. A reel gets its link and DM keyword when it is published.</p>
      ) : (
        <ul className="space-y-3">
          {view.sales.reels.map((reel) => (
            <ReelLine key={reel.creativeId} reel={reel} />
          ))}
        </ul>
      )}
      <p className="text-sm text-muted">
        {view.sales.unmatched} order(s) are not matched to a reel. They are kept without one. Orders carry no customer details.
      </p>
    </div>
  );
}

function ReelLine({ reel }: { reel: ReelSales }) {
  return (
    <li className="space-y-1 rounded-md border border-border p-3 text-sm">
      <p className="font-medium">{reel.title || "Untitled reel"}</p>
      <p className="text-muted">DM keyword: {reel.dmKeyword}</p>
      <p>
        {reel.linkUrl ? (
          <a href={reel.linkUrl} target="_blank" rel="noopener noreferrer" className="underline">
            Tagged link
          </a>
        ) : (
          "No link: the brand has no product URL."
        )}
      </p>
      <p>
        {reel.orders} order(s), {reel.matchedByUtm} by link, {reel.matchedByKeyword} by keyword.
        {reel.unknownTotal > 0 ? ` ${reel.unknownTotal} with no stored total.` : ""}
      </p>
      {reel.byCurrency.map((line) => (
        <p key={`${line.currency ?? "none"}`} className="text-muted">
          {line.currency ?? "Currency not stored"}: {line.total} across {line.orders} order(s)
        </p>
      ))}
    </li>
  );
}
