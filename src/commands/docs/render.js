import fs from "node:fs/promises";
import path from "node:path";

export async function renderEnvironment(envVars, docsRoot) {
  const dir = path.join(docsRoot, "environment");
  await fs.mkdir(dir, { recursive: true });

  const lines = [
    "# Environment Variables",
    "",
    "| Name | Required | Default / Example | Description |",
    "|---|---|---|---|",
  ];

  for (const v of envVars) {
    lines.push(
      `| \`${v.name}\` | ${v.required ? "**Yes**" : "No"} | ${v.value ? `\`${v.value}\`` : "—"} | ${v.comment ?? "—"} |`,
    );
  }

  await fs.writeFile(path.join(dir, "variables.md"), lines.join("\n") + "\n");
}

export async function renderAgentJson(envVars, docsRoot, filename) {
  const agentsDir = path.join(docsRoot, "agents");
  await fs.mkdir(agentsDir, { recursive: true });
  const payload = {
    $schema: "godprotocol/v1/environment.schema.json",
    variables: envVars.map((v) => ({
      name: v.name,
      required: v.required,
      default: v.value ?? null,
      description: v.comment ?? null,
      source: v.source,
    })),
  };
  await fs.writeFile(
    path.join(agentsDir, filename),
    JSON.stringify(payload, null, 2),
  );
}

export async function renderOverview(meta, docsRoot) {
  const dir = path.join(docsRoot, "architecture");
  await fs.mkdir(dir, { recursive: true });

  const lines = [
    `# ${meta.projectName}`,
    "",
    meta.description ?? "_No description in package.json._",
    "",
    "## Summary",
    "",
    `- **API routes:** ${meta.routeCount}`,
    `- **Environment variables:** ${meta.envVarCount}`,
    "",
    "## Generated docs",
    "",
    "- [API Reference](../api/index.md)",
    "- [Environment Variables](../environment/variables.md)",
    "",
  ];

  await fs.writeFile(path.join(dir, "overview.md"), lines.join("\n"));
}
