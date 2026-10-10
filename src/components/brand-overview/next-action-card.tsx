import { Link } from "@tanstack/react-router";
import { ArrowRight } from "lucide-react";
import { Button, Card } from "@/components/ui";
import type { NextAction } from "./pipeline";

/** One recommended action with one button. The title and body come from the pure model, which reads the same stored data as the pipeline. */
export function NextActionCard({ brandId, action }: { brandId: string; action: NextAction }) {
  return (
    <Card aria-labelledby="next-action-title" className="flex h-full flex-col gap-3 border-accent/40 bg-accent-soft/40">
      <p className="eyebrow">Next best action</p>
      <h2 id="next-action-title" className="text-xl font-semibold text-fg">{action.title}</h2>
      <p className="text-sm text-fg-muted">{action.body}</p>
      <div className="mt-auto pt-2">
        <Button asChild>
          <Link to={action.to} params={{ brandId }}>
            {action.cta} <ArrowRight aria-hidden="true" className="size-4" />
          </Link>
        </Button>
      </div>
    </Card>
  );
}
