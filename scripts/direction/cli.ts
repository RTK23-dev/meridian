// Direction tools for an agent (agent mode: no provider call, no spend). See .claude/skills/direction-scripts/SKILL.md.
//
//   node --experimental-strip-types scripts/direction/cli.ts <command> [options]
//
//   example                                   print an example request file to copy (its product and numbers are invented)
//   deal    --request r.json [--count 6] [--seed s]
//                                             deal the creative cards to write concepts on (the request's niche weights the deck)
//   prompt  <step> --request r.json [...]     print the pinned prompt and the user message a run sends that step:
//             concept_lab     --cards cards.json
//             script_director --concept concept.json [--draft script.json] [--note "what to change"]
//             swipe_test      --script script.json
//   filter  --request r.json --answers a.json drop the obvious ideas, repeated hooks and near-duplicates from concept-lab answers
//   check   --request r.json --script s.json  check a script with every check a run applies (exit 1 when it is blocked or does not fit)
//   use     --request r.json --script s.json  print the script lines, the engine's script and the direction note (refused when blocked)
//
// Every file is JSON. Output is JSON on stdout; a refusal is one line on stderr and exit code 1.

import { readFileSync } from "node:fs";
import { checkScript, dealCards, exampleRequest, filterAnswers, readRequest, revisionMessage, roleMessage, scriptForUse } from "../../src/lib/meridian/direction/agent-tools.ts";
import { parseAnswer } from "../../src/lib/meridian/direction/answers.ts";
import { directedScriptV2Schema } from "../../src/lib/meridian/direction/script.ts";
import type { DirectionRequest, DirectorConcept } from "../../src/lib/meridian/direction/pipeline.ts";
import type { DeckCard } from "../../src/lib/meridian/direction/concepts.ts";

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
}

function json(path: string | undefined, what: string): unknown {
  if (!path) fail(`Give --${what} <file.json>.`);
  try {
    return JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch (error) {
    fail(`${path} could not be read as JSON: ${error instanceof Error ? error.message : "unknown error"}`);
  }
}

function request(args: string[]): DirectionRequest {
  const read = readRequest(json(option(args, "request"), "request"));
  if (!read.ok) fail(`The request does not fit: ${read.error}`);
  return read.request;
}

function print(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

const [command, ...args] = process.argv.slice(2);
switch (command) {
  case "example":
    print(exampleRequest());
    break;
  case "deal": {
    const read = request(args);
    const count = Number(option(args, "count") ?? 6);
    if (!Number.isInteger(count) || count < 1 || count > 24) fail("Deal 1 to 24 cards.");
    print(dealCards({ count, seed: option(args, "seed") ?? `agent:${Date.now()}`, niche: read.niche }));
    break;
  }
  case "prompt": {
    const step = args[0];
    const read = request(args);
    if (step === "concept_lab") print(roleMessage({ step, request: read, cards: json(option(args, "cards"), "cards") as DeckCard[] }));
    else if (step === "script_director") {
      const concept = json(option(args, "concept"), "concept") as DirectorConcept;
      const draftPath = option(args, "draft");
      if (draftPath) {
        const draft = parseAnswer(JSON.stringify(json(draftPath, "draft")), directedScriptV2Schema);
        if (!draft.ok) fail(`The draft does not fit the script contract: ${draft.error}`);
        print(revisionMessage(read, concept, draft.value, option(args, "note")));
      } else print(roleMessage({ step, request: read, concept }));
    } else if (step === "swipe_test") {
      const script = parseAnswer(JSON.stringify(json(option(args, "script"), "script")), directedScriptV2Schema);
      if (!script.ok) fail(`The script does not fit the script contract: ${script.error}`);
      print(roleMessage({ step, request: read, script: script.value }));
    } else fail("Name the step: concept_lab, script_director or swipe_test.");
    break;
  }
  case "filter": {
    const answers = json(option(args, "answers"), "answers");
    const result = filterAnswers(request(args), Array.isArray(answers) ? answers : [answers]);
    if (!result.ok) fail(result.error);
    print(result);
    break;
  }
  case "check": {
    const result = checkScript(request(args), json(option(args, "script"), "script"));
    if (!result.ok) fail(`The script does not fit the script contract: ${result.error}`);
    print({ blocked: result.blocked, floors: result.report.floors, counts: result.report.counts, findings: result.report.findings, timeline: result.report.timeline, metrics: result.report.metrics });
    if (result.blocked) process.exitCode = 1;
    break;
  }
  case "use": {
    const result = scriptForUse(request(args), json(option(args, "script"), "script"));
    if (!result.ok) fail(result.error);
    print(result);
    break;
  }
  default:
    fail("Commands: example, deal, prompt, filter, check, use. Read the header of scripts/direction/cli.ts.");
}
