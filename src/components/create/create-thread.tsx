import { ArrowUpRight } from "lucide-react";
import type { Message } from "@/lib/meridian/content-factory/model";
import { CREATE_SUGGESTIONS } from "./create-model";

/**
 * The conversation on the Create page. Empty, it shows what the page can make, as three starting points a person can tap. With messages,
 * each one is a saved line of the draft, and a note says what has and has not happened: a message only saves text to a draft.
 */
export function CreateThread({ messages, onSuggest }: { messages: Message[]; onSuggest: (text: string) => void }) {
  if (messages.length === 0) {
    return (
      <section aria-labelledby="create-start" className="flex flex-col gap-6 pt-4">
        <div className="space-y-2">
          <p className="eyebrow">Start here</p>
          <h2 id="create-start" className="font-display text-2xl font-semibold tracking-tight text-fg-primary">What should we make?</h2>
          <p className="max-w-prose text-sm text-fg-secondary">Describe it in your own words. Meridian turns it into a draft you can review before anything runs.</p>
        </div>
        <ul className="flex flex-col gap-2" aria-label="Starting points">
          {CREATE_SUGGESTIONS.map((suggestion) => (
            <li key={suggestion}>
              <button
                type="button"
                onClick={() => onSuggest(suggestion)}
                className="flex min-h-11 w-full items-center justify-between gap-3 border border-hairline bg-raised px-4 py-3 text-left text-sm text-fg-primary transition-colors hover:border-border-strong focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
              >
                <span>{suggestion}</span>
                <ArrowUpRight aria-hidden="true" className="size-4 shrink-0 text-fg-muted" />
              </button>
            </li>
          ))}
        </ul>
      </section>
    );
  }
  return (
    <section aria-label="Your messages" className="flex flex-col gap-5 pt-4">
      <ol className="flex flex-col gap-4">
        {messages.map((message) => (
          <li key={message.id} className="flex flex-col items-end gap-1">
            <div className="max-w-[85%] whitespace-pre-wrap border border-hairline bg-raised px-4 py-3 text-body text-fg-primary">{message.text}</div>
            <p className="text-caption text-fg-muted">
              {message.authorName ?? "You"} · <time dateTime={message.createdAt}>{new Date(message.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time>
            </p>
          </li>
        ))}
      </ol>
      <p role="status" className="border-t border-hairline pt-3 text-caption text-fg-muted">
        Saved to your draft. Nothing has started, and nothing has been spent.
      </p>
    </section>
  );
}
