import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_PORT,
  announceLines,
  isFirstStart,
  isLocalDatabase,
  needsSetup,
  portFromArgs,
  viteArgs,
} from "./dev.mjs";

test("the port is the value after --port or --port=, and 8080 otherwise", () => {
  assert.equal(DEFAULT_PORT, 8080);
  assert.equal(portFromArgs([]), 8080);
  assert.equal(portFromArgs(["--port", "8081"]), 8081);
  assert.equal(portFromArgs(["--port=8082"]), 8082);
  assert.equal(portFromArgs(["--port", "abc"]), 8080);
  assert.equal(portFromArgs(["--host", "0.0.0.0", "--port", "70000"]), 8080);
});

test("vite gets the dev command on 0.0.0.0:8080 unless the caller gives a host or a port", () => {
  assert.deepEqual(viteArgs([]), ["dev", "--host", "0.0.0.0", "--port", "8080"]);
  assert.deepEqual(viteArgs(["--port", "8081"]), ["dev", "--host", "0.0.0.0", "--port", "8081"]);
  assert.deepEqual(viteArgs(["--host=127.0.0.1"]), ["dev", "--port", "8080", "--host=127.0.0.1"]);
});

test("setup runs only when .env or node_modules is missing", () => {
  assert.equal(needsSetup({ envFileExisted: false, nodeModulesExist: true }), true);
  assert.equal(needsSetup({ envFileExisted: true, nodeModulesExist: false }), true);
  assert.equal(needsSetup({ envFileExisted: true, nodeModulesExist: true }), false);
});

test("a blank or unset DATABASE_URL is the local trial, and any other value is a real database", () => {
  assert.equal(isLocalDatabase(undefined), true);
  assert.equal(isLocalDatabase(""), true);
  assert.equal(isLocalDatabase("   "), true);
  assert.equal(isLocalDatabase("postgres://meridian@db.internal:5432/meridian"), false);
});

test("a first start is a new .env, or a local database that does not exist yet", () => {
  assert.equal(
    isFirstStart({ envFileExisted: false, localDatabase: false, dataDirExisted: true }),
    true,
  );
  assert.equal(
    isFirstStart({ envFileExisted: true, localDatabase: true, dataDirExisted: false }),
    true,
  );
  assert.equal(
    isFirstStart({ envFileExisted: true, localDatabase: true, dataDirExisted: true }),
    false,
  );
  assert.equal(
    isFirstStart({ envFileExisted: true, localDatabase: false, dataDirExisted: false }),
    false,
  );
});

test("a local first start names the database folder, says jobs run here, and gives the three steps", () => {
  const lines = announceLines({
    origin: "http://127.0.0.1:8080",
    localDatabase: true,
    dataDir: "/work/meridian/.data/pglite",
    firstStart: true,
  });
  const text = lines.join("\n");
  assert.match(text, /Meridian is running at http:\/\/127\.0\.0\.1:8080\. Stop it with Ctrl\+C\./);
  assert.match(
    text,
    /embedded database in \/work\/meridian\/\.data\/pglite\. It is kept between restarts\./,
  );
  assert.match(text, /the queued jobs run in this dev server, so no worker process is needed/);
  assert.match(text, /Three steps to a working brand:/);
  assert.match(text, /1\. Open http:\/\/127\.0\.0\.1:8080 in a browser\./);
  assert.match(
    text,
    /2\. Create an account\. On the sign-in page, choose "Create an account instead"\./,
  );
  assert.match(text, /3\. Create a workspace, then a brand, and complete the brand brain\./);
});

test("a later local start says what is running, without the three steps", () => {
  const text = announceLines({
    origin: "http://127.0.0.1:8081",
    localDatabase: true,
    dataDir: "/work/meridian/.data/pglite",
    firstStart: false,
  }).join("\n");
  assert.match(text, /Meridian is running at http:\/\/127\.0\.0\.1:8081/);
  assert.doesNotMatch(text, /Three steps/);
});

test("with DATABASE_URL the start says this server does not run the jobs, and names the two processes that do", () => {
  const text = announceLines({
    origin: "http://127.0.0.1:8080",
    localDatabase: false,
    dataDir: "",
    firstStart: false,
  }).join("\n");
  assert.match(text, /Database: DATABASE_URL, a Postgres database\./);
  assert.match(
    text,
    /this server does not run them\. Start npm run worker and npm run scheduler\./,
  );
  assert.doesNotMatch(text, /embedded database/);
});
