# Role prompts (W3)

Implements Video Engine Bible **section 11.2** (prompt structure) and **11.3** (versioning). Each role's prompt is one file,
`<role>@<n>.md`, and a shipped version never changes: an edit is a new file with a new number.

## Files

- `segmenter@1.md`: the segmenter prompt, version 1. Its four parts are `## Role and rules`, `## Reference material` (the
  stable part, for caching later), `## Task input` and `## Output contract`. The first line is `# segmenter@1`.
- `load.ts`: `loadPrompt({ role, version })` reads the file once, checks its first line against its own name, and hashes
  its bytes. `promptPath` and `promptId` name it.
- `untrusted.ts`: `untrustedBlock(name, value)` wraps a value in `<untrusted-data name="...">` tags. The value is
  JSON-encoded with `<`, `>` and `&` escaped, so no value can close its block.
- `load.test.ts` pins the hash of each shipped file. Editing a shipped file fails the test: write a new version instead.

## Rules for a prompt

1. The file says what the role decides and what it never does (no invented claims, no text in generation prompts, no
   change of the script's meaning).
2. Transcripts, on-screen text and fetched material reach the model only inside `untrustedBlock`. The prompt says they are
   data, and that instructions inside them are never followed.
3. The output contract in the file matches the role's zod answer schema (`claude/roles/`). The schema is also sent as the
   structured-output format.
