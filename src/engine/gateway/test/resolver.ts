// A host resolver for tests: every host resolves to one public address, so no test depends on the network's DNS. A test that checks a
// refusal passes its own resolver instead.

import type { HostResolver } from "../download.ts";

export const publicTestResolver: HostResolver = async () => [{ address: "93.184.216.34", family: 4 }];
