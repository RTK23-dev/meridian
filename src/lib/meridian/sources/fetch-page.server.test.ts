import assert from "node:assert/strict";
import test from "node:test";
import { fetchPublicHtml, fetchPublicMedia, htmlToText, resolveAndPinHost } from "./fetch-page.server.ts";

test("the connection lookup stays pinned to the address that passed validation", async () => {
  let resolutions = 0;
  const pinnedLookup = await resolveAndPinHost("example.test", async () => {
    resolutions += 1;
    return resolutions === 1
      ? [{ address: "8.8.8.8", family: 4 }]
      : [{ address: "127.0.0.1", family: 4 }];
  });

  let connectedAddress = "";
  const invokeLookup = pinnedLookup as unknown as (
    hostname: string,
    options: { all: false; family: 4 },
    callback: (error: NodeJS.ErrnoException | null, address: string, family: number) => void,
  ) => void;
  invokeLookup("example.test", { all: false, family: 4 }, (error, address) => {
    assert.ifError(error);
    connectedAddress = address;
  });

  assert.equal(connectedAddress, "8.8.8.8");
  assert.equal(resolutions, 1);
});

test("private addresses remain blocked during DNS validation", async () => {
  await assert.rejects(
    resolveAndPinHost("example.test", async () => [
      { address: "8.8.8.8", family: 4 },
      { address: "169.254.169.254", family: 4 },
    ]),
    /That host does not resolve to a public address\./,
  );
});

test("research snapshot and media fetchers reject private destinations before connecting", async () => {
  await assert.rejects(fetchPublicHtml("http://127.0.0.1/snapshot"), /not a public host/);
  await assert.rejects(fetchPublicMedia("http://169.254.169.254/latest/meta-data"), /not a public host/);
});

test("HTML text decodes common named and numeric entities once", () => {
  const text = htmlToText("<p>Tom &amp; Jerry &lt;3 &gt; all &quot;x&quot; &apos;y&apos; &#x41;&nbsp;ok</p>");
  assert.equal(text, `Tom & Jerry <3 > all "x" 'y' A ok`);
  assert.equal(htmlToText("&amp;lt;b&amp;gt;"), "&lt;b&gt;");
  assert.equal(htmlToText("a&#0;b&#xD800;c&#99999999;d"), "a b c d");
});
