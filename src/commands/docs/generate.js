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
   * The documentation site lives directly at:
   *
   *   <projectRoot>/docs
   *
   * And the generated Markdown also lives directly inside it:
   *
   *   docs/
   *   ├── api/
   *   ├── architecture/
   *   ├── environment/
   *   ├── agents/
   *   ├── docusaurus.config.js
   *   ├── sidebars.js
   *   └── package.json
   *
   * There is intentionally NO docs/docs/ directory.
   */
  const docsProject = await ensureDocusaurusProject(projectRoot);
  const docsRoot = path.join(docsProject, "docs");

  await fs.mkdir(docsRoot, { recursive: true });

  /*
   * Read package.json from the GodProtocol project,
   * not the Docusaurus project.
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
   * Scan project.
   */
  console.log("Scanning project...");

  const envVars = await scanEnv(projectRoot);
  const routes = await buildRoutes(projectRoot, docsRoot);

  console.log(`ROUTES FOUND: ${routes.length}`);
  console.log(`ENVIRONMENT VARIABLES FOUND: ${envVars.length}`);

  /*
   * Generate/update Markdown.
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
   * Update Docusaurus navigation.
   */
  await updateSidebar(docsProject, {
    routes,
    envVars,
  });

  /*
   * Versioning.
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

async function ensureDocusaurusProject(projectRoot) {
  // IMPORTANT:
  // The generated Docusaurus project lives at:
  //
  //   <projectRoot>/docs
  //
  // And the actual Docusaurus documentation content lives at:
  //
  //   <projectRoot>/docs/docs
  //
  // This is the normal Docusaurus structure.

  const docsProject = path.join(projectRoot, "docs");
  const docsRoot = path.join(docsProject, "docs");

  // ---------------------------------------------------------------------------
  // Existing Docusaurus project
  // ---------------------------------------------------------------------------

  if (await exists(path.join(docsProject, "docusaurus.config.js"))) {
    console.log(`Using existing Docusaurus project: ${docsProject}`);

    await fs.mkdir(docsRoot, { recursive: true });

    await patchDocusaurusConfig(docsProject);

    return docsProject;
  }

  // ---------------------------------------------------------------------------
  // Create new Docusaurus project
  // ---------------------------------------------------------------------------

  console.log("Creating Docusaurus documentation project...");
  console.log("");

  await createDocusaurusProject(docsProject);

  await fs.mkdir(docsRoot, { recursive: true });

  // create-docusaurus generates a configuration based on its template.
  // Normalize it immediately so the generated project is ready to use.
  await patchDocusaurusConfig(docsProject);

  return docsProject;
}

async function patchDocusaurusConfig(docsProject) {
  const configFile = path.join(docsProject, "docusaurus.config.js");

  if (!(await exists(configFile))) {
    throw new Error(`Docusaurus config not found: ${configFile}`);
  }

  const config = `
/** @type {import('@docusaurus/types').Config} */

const config = {
  title: 'GodProtocol API',
  tagline: 'API Documentation',
  favicon: 'img/favicon.ico',

  url: 'http://localhost:3000',
  baseUrl: '/',

  onBrokenLinks: 'throw',
  onBrokenMarkdownLinks: 'warn',

  i18n: {
    defaultLocale: 'en',
    locales: ['en'],
  },

  presets: [
    [
      'classic',
      {
        docs: {
          path: 'docs',
          routeBasePath: 'docs',
          sidebarPath: './sidebars.js',
          showLastUpdateTime: false,
          showLastUpdateAuthor: false,
        },

        blog: false,

        theme: {
          customCss: './src/css/custom.css',
        },
      },
    ],
  ],

  themeConfig: {
    navbar: {
      title: 'GodProtocol API',

      items: [
        {
          type: 'docSidebar',
          sidebarId: 'docs',
          position: 'left',
          label: 'API',
        },
      ],
    },

    footer: {
      style: 'dark',

      links: [
        {
          title: 'Documentation',
          items: [
            {
              label: 'API',
              to: '/docs/api',
            },
          ],
        },
      ],

      copyright:
        \`Copyright © \${new Date().getFullYear()} GodProtocol. Built with Docusaurus.\`,
    },

    prism: {
      theme: require('prism-react-renderer').themes.github,
      darkTheme: require('prism-react-renderer').themes.dracula,
    },
  },
};

module.exports = config;
`;

  await fs.writeFile(configFile, config.trim() + "\n", "utf8");
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
async function updateSidebar(docsProject, documentation = {}) {
  console.log("Updating Docusaurus sidebar...");

  const docsRoot = path.join(docsProject, "docs");
  const sidebarFile = path.join(docsProject, "sidebars.js");

  /*
   * Docusaurus document IDs are relative to docsRoot.
   *
   * Example:
   *
   * docs/
   *   api/
   *     index.md
   *     v3.md
   *
   * becomes:
   *
   * api/index
   * api/v3
   *
   * IMPORTANT:
   * We intentionally build the sidebar from the files that actually
   * exist on disk. This prevents stale route/category entries from
   * surviving between documentation generations.
   */

  if (!(await exists(docsRoot))) {
    throw new Error(`Docusaurus docs directory does not exist: ${docsRoot}`);
  }

  const documentIds = await collectMarkdownDocumentIds(docsRoot);

  /*
   * Never allow Docusaurus's generated/default tutorial documents
   * to interfere with our generated API documentation.
   *
   * We keep intro/tutorial docs if they still exist, because an
   * existing Docusaurus project may have them.
   */

  const apiDocs = documentIds
    .filter((id) => id.startsWith("api/"))
    .sort((a, b) => {
      /*
       * Keep api/index first.
       */
      if (a === "api/index") return -1;
      if (b === "api/index") return 1;

      return a.localeCompare(b);
    });

  const architectureDocs = documentIds
    .filter((id) => id.startsWith("architecture/"))
    .sort();

  const environmentDocs = documentIds
    .filter((id) => id.startsWith("environment/"))
    .sort();

  const tutorialDocs = documentIds
    .filter(
      (id) =>
        id === "intro" ||
        id.startsWith("tutorial-basics/") ||
        id.startsWith("tutorial-extras/"),
    )
    .sort();

  const sidebar = {
    docs: [],
  };

  /*
   * API
   */
  if (apiDocs.length > 0) {
    const handlerDocs = apiDocs.filter((id) => id !== "api/index");

    const apiCategory = {
      type: "category",
      label: "API Reference",
      items: handlerDocs,
    };

    if (apiDocs.includes("api/index")) {
      apiCategory.link = {
        type: "doc",
        id: "api/index",
      };
    }

    sidebar.docs.push(apiCategory);
  }

  /*
   * Architecture
   */
  if (architectureDocs.length > 0) {
    sidebar.docs.push({
      type: "category",
      label: "Architecture",
      items: architectureDocs,
    });
  }

  /*
   * Environment
   */
  if (environmentDocs.length > 0) {
    sidebar.docs.push({
      type: "category",
      label: "Environment",
      items: environmentDocs,
    });
  }

  /*
   * Preserve Docusaurus tutorial material when it exists.
   */
  if (tutorialDocs.length > 0) {
    sidebar.docs.push({
      type: "category",
      label: "Tutorial",
      items: tutorialDocs,
    });
  }

  /*
   * Write a completely deterministic sidebar.
   *
   * We deliberately do NOT merge with the old sidebar.
   *
   * The old implementation caused exactly the problem you're seeing:
   *
   * old file:
   *   api/async.md
   *
   * gets deleted/replaced by:
   *   api/v3.md
   *
   * but:
   *   api/async
   *
   * remains in sidebars.js.
   *
   * That is invalid to Docusaurus.
   */

  const contents = `/**
 * This file is generated by GodProtocol.
 *
 * Do not manually edit this file.
 * Run:
 *
 *   npx godprotocol-cli docs generate
 *
 * to regenerate it.
 */

const sidebars = ${JSON.stringify(sidebar, null, 2)};

export default sidebars;
`;

  await fs.writeFile(sidebarFile, contents, "utf8");

  console.log(`✔ Sidebar updated: ${sidebarFile}`);

  /*
   * Remove Docusaurus's generated cache.
   *
   * This is important during development because Docusaurus can
   * retain registry information for documents that no longer exist.
   */
  await removeIfExists(path.join(docsProject, ".docusaurus"));

  console.log("✔ Cleared Docusaurus cache");
}

/**
 * Recursively find every Markdown document under docsRoot and convert
 * it to a Docusaurus document ID.
 */
async function collectMarkdownDocumentIds(docsRoot) {
  const ids = [];

  async function walk(currentDir) {
    let entries;

    try {
      entries = await fs.readdir(currentDir, {
        withFileTypes: true,
      });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);

      if (entry.isDirectory()) {
        /*
         * Never scan node_modules or Docusaurus internals.
         */
        if (
          entry.name === "node_modules" ||
          entry.name === ".docusaurus" ||
          entry.name === ".git"
        ) {
          continue;
        }

        await walk(fullPath);
        continue;
      }

      if (!entry.isFile()) continue;

      /*
       * Only Markdown documentation belongs in the sidebar.
       */
      if (!entry.name.endsWith(".md")) continue;

      const relative = path.relative(docsRoot, fullPath);

      /*
       * Convert:
       *
       * api/v3.md
       *
       * to:
       *
       * api/v3
       */
      let id = relative.replace(/\\/g, "/").replace(/\.md$/i, "");

      /*
       * Docusaurus treats index.md specially, but keeping
       * api/index is valid and explicit.
       */
      ids.push(id);
    }
  }

  await walk(docsRoot);

  return [...new Set(ids)];
}

async function removeIfExists(target) {
  try {
    await fs.rm(target, {
      recursive: true,
      force: true,
    });
  } catch {
    // Ignore missing/unremovable cache directories.
  }
}

/**
 * Enable/update Docusaurus versioning.
 */
async function updateDocsVersioning(docsProject) {
  console.log("Checking Docusaurus documentation versioning...");

  // We intentionally do not create a version on every documentation build.
  //
  // Docusaurus versioning is opt-in. A normal:
  //
  //   godprotocol-cli docs generate
  //
  // should always operate on the current documentation.
  //
  // If the user later explicitly versions the docs, Docusaurus can manage:
  //
  //   versioned_docs/
  //   versioned_sidebars/
  //
  // independently.

  const versionedDocsDir = path.join(docsProject, "versioned_docs");
  const versionedSidebarsDir = path.join(docsProject, "versioned_sidebars");

  const hasVersionedDocs = await exists(versionedDocsDir);
  const hasVersionedSidebars = await exists(versionedSidebarsDir);

  if (hasVersionedDocs || hasVersionedSidebars) {
    console.log("Existing Docusaurus versions detected.");
  } else {
    console.log("No Docusaurus documentation versions configured.");
  }
}

async function exists(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}
