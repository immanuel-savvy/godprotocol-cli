import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const cliEntry = path.resolve(__dirname, "../bin/godprotocol-cli.js");

test("init scaffolds a GodProtocol project", async (t) => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "godprotocol-"));
  const projectDir = path.join(tmpDir, "my-api");
  await fs.mkdir(projectDir, { recursive: true });

  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execFileAsync = promisify(execFile);

  await execFileAsync(process.execPath, [cliEntry, "init"], {
    cwd: projectDir
  });

  const indexContent = await fs.readFile(
    path.join(projectDir, "index.js"),
    "utf8"
  );
  assert.match(indexContent, /my-api\.js/);

  const appFile = await fs.readFile(
    path.join(projectDir, "my-api.js"),
    "utf8"
  );
  assert.match(appFile, /express/);

  const routerV1 = await fs.stat(
    path.join(projectDir, "routes", "router-v1.js")
  );
  assert.ok(routerV1.isFile());

  const handlersV1 = await fs.stat(
    path.join(projectDir, "handlers", "v1")
  );
  assert.ok(handlersV1.isDirectory());

  await fs.rm(tmpDir, { recursive: true, force: true });
});
