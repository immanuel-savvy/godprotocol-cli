import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

import { scanEnv } from "./scan.js";
import {
  renderEnvironment,
  renderAgentJson,
  renderOverview,
} from "./render.js";

import { buildRoutes } from "./build-routes.js";

export async function generateDocs(projectRoot) {
  console.log("");
  console.log("GodProtocol Docs");
  console.log("────────────────");
  console.log("");

  /*
   * The Docusaurus project is the documentation output.
   *
   * IMPORTANT:
   * projectRoot = the GodProtocol project being documented
   * docsRoot    = the Docusaurus docs directory
   */
  const docsProject = await ensureDocusaurusProject(projectRoot);

  const docsRoot = path.join(docsProject, "docs");

  await fs.mkdir(docsRoot, { recursive: true });

  /*
   * package.json
   *
   * Read this from the GodProtocol project,
   * not from the Docusaurus project.
   */
  let pkg = {};

  try {
    const pkgText = await fs.readFile(
      path.join(projectRoot, "package.json"),
      "utf8",
    );

    pkg = JSON.parse(pkgText);
  } catch {
    pkg = {};
  }

  /*
   * Scan project
   */
  console.log("Scanning project...");

  const envVars = await scanEnv(projectRoot);

  const routes = await buildRoutes(projectRoot, docsRoot);

  console.log(`ROUTES FOUND: ${routes.length}`);
  console.log(`ENVIRONMENT VARIABLES FOUND: ${envVars.length}`);

  /*
   * Generate/update Markdown
   */
  console.log("");
  console.log("Writing documentation...");

  await renderEnvironment(envVars, docsRoot);

  console.log("✔ Generated docs/environment/variables.md");

  await renderAgentJson(envVars, docsRoot, "environment.variables.json");

  console.log("✔ Generated docs/agents/environment.variables.json");

  await renderOverview(
    {
      projectName: pkg.name ?? path.basename(projectRoot),
      description: pkg.description ?? null,
      routeCount: routes.length,
      envVarCount: envVars.length,
    },
    docsRoot,
  );

  console.log("✔ Generated docs/architecture/overview.md");

  /*
   * Update Docusaurus navigation
   */
  await updateSidebar(docsProject, {
    routes,
    envVars,
  });

  /*
   * Docusaurus versioning
   */
  await updateDocsVersioning(docsProject);

  console.log("");
  console.log("Documentation generated successfully.");
  console.log("");
  console.log(`Project: ${pkg.name ?? path.basename(projectRoot)}`);
  console.log(`Routes: ${routes.length}`);
  console.log(`Environment Variables: ${envVars.length}`);
  console.log("");

  return docsProject;
}

/**
 * Find or create the Docusaurus documentation project.
 *
 * The GodProtocol project itself is NOT the Docusaurus project.
 *
 * Example:
 *
 * my-api/
 * ├── package.json
 * ├── routes/
 * ├── handlers/
 * └── ...
 *
 * becomes:
 *
 * my-api/
 * ├── ...
 * └── docs-site/
 *     ├── docs/
 *     ├── src/
 *     ├── docusaurus.config.js
 *     └── sidebars.js
 */

async function ensureDocusaurusProject(projectRoot) {
  const docsProject = path.join(projectRoot, "docs-site");

  // Existing Docusaurus project
  if (await exists(path.join(docsProject, "docusaurus.config.js"))) {
    console.log(`Using existing Docusaurus project: ${docsProject}`);

    await fs.mkdir(path.join(docsProject, "docs"), {
      recursive: true,
    });

    return docsProject;
  }

  // Create new Docusaurus project
  console.log("Creating Docusaurus documentation project...");

  await createDocusaurusProject(docsProject);

  return docsProject;
}

function createDocusaurusProject(docsProject) {
  return new Promise((resolve, reject) => {
    console.log("");
    console.log("Creating Docusaurus documentation project...");
    console.log("Downloading Docusaurus and installing dependencies...");
    console.log("");

    const child = spawn(
      "npx",
      ["create-docusaurus@latest", docsProject, "classic", "--javascript"],
      {
        stdio: "inherit",
        cwd: path.dirname(docsProject),
      },
    );

    child.on("error", (error) => {
      reject(error);
    });

    child.on("close", (code) => {
      if (code === 0) {
        console.log("");
        console.log("✔ Docusaurus project created.");
        console.log("");

        resolve();
        return;
      }

      reject(new Error(`create-docusaurus exited with code ${code}`));
    });
  });
}

/**
 * Update the Docusaurus sidebar.
 */
async function updateSidebar(docsProject, documentation) {
  /*
   * This should modify:
   *
   * docs-site/sidebars.js
   *
   * based on the documentation that was generated.
   *
   * Do not blindly overwrite the entire sidebar if the
   * user has manually configured it.
   */

  console.log("Updating Docusaurus sidebar...");

  // TODO: implement sidebar generation/update.
}

/**
 * Enable/update Docusaurus versioning.
 */
async function updateDocsVersioning(docsProject) {
  /*
   * Docusaurus versioning is based on:
   *
   * docs/
   * versioned_docs/
   * versioned_sidebars/
   *
   * and commands such as:
   *
   * yarn docusaurus docs:version 1.0
   *
   * or the equivalent npm command.
   *
   * We should NOT create a new version every time
   * `docs generate` runs.
   */

  console.log("Checking Docusaurus documentation versioning...");

  // TODO: implement version detection/creation.
}

async function exists(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}
