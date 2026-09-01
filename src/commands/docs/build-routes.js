import fs from "node:fs/promises";
import path from "node:path";
import { scanRouterFiles } from "./scan-routes.js";
import { evaluateSchema, describeSchemaSection } from "./scan-schema.js";
import { extractHandlerDetails } from "./scan-handler-details.js";

const REQUIRED_RANK = { conditional: 2, "optional (group)": 1 };

export async function buildRoutes(projectRoot, docsRoot) {
  const rawRoutes = await scanRouterFiles(projectRoot);
  const built = [];

  for (const route of rawRoutes) {
    const handlerDetails = await extractHandlerDetails(
      route.handler?.source ?? null,
      {
        handlerFile: route.handler?.file ?? null,
        projectRoot,
        maxFiles: 100,
        maxFunctions: 500,
        maxDepth: 20,
      },
    );

    built.push({
      name: route.name,
      category: route.category,
      security: route.security,
      method: route.method ?? null,
      path: route.path ?? null,
      routeFile: route.routeFile,
      handler: route.handler,
      request: buildRequestSchema(route.schemaRaw),
      response: {
        ref: "StandardResponse",
        data: handlerDetails.responseDataFields,
        success: handlerDetails.successResponses,
      },
      externalServices: handlerDetails.externalServices,
      errors: handlerDetails.errors,
      /*
       * An explicit `description:` written on the route entry is
       * authoritative and takes priority over a leading-comment
       * inference from the handler source.
       */
      purpose: route.description ?? handlerDetails.purpose,
    });
  }

  // One Markdown page per handler source file.
  await renderRouteFiles(built, docsRoot);

  // One machine-readable route index.
  await renderRoutesJson(built, docsRoot);

  return built;
}

function buildRequestSchema(schemaRaw) {
  if (!schemaRaw) {
    return {
      defined: false,
      body: [],
      logic: null,
      query: [],
      queryLogic: null,
      params: [],
      paramsLogic: null,
      confidence: "extracted",
    };
  }

  const evaluated = evaluateSchema(schemaRaw);

  if (!evaluated.ok) {
    return {
      defined: false,
      body: [],
      logic: null,
      query: [],
      queryLogic: null,
      params: [],
      paramsLogic: null,
      confidence: "extracted",
      evalError: evaluated.error,
    };
  }

  const bodyRules = evaluated.value.body ?? {};
  const queryRules = evaluated.value.query ?? {};
  const paramsRules = evaluated.value.params ?? {};

  const { fields: bodyFields, logic: bodyLogic } =
    describeSchemaSection(bodyRules);
  const { fields: queryFields, logic: queryLogic } =
    describeSchemaSection(queryRules);
  const { fields: paramsFields, logic: paramsLogic } =
    describeSchemaSection(paramsRules);

  return {
    defined:
      bodyFields.length > 0 ||
      !!bodyLogic ||
      queryFields.length > 0 ||
      !!queryLogic ||
      paramsFields.length > 0 ||
      !!paramsLogic,
    body: bodyFields,
    logic: bodyLogic,
    query: queryFields,
    queryLogic,
    params: paramsFields,
    paramsLogic,
    confidence: "extracted",
  };
}

export function mergeFieldsWithLogic(fields, logic) {
  const byName = new Map(
    fields.map((f) => [f.field, { ...f, required: f.required ? true : false }]),
  );

  const markGroup = (properties, type, required, description) => {
    const label = required ? "conditional" : "optional (group)";

    for (const prop of properties) {
      if (byName.has(prop)) {
        const existing = byName.get(prop);
        existing.required = strongerRequired(existing.required, label);

        if (!existing.description && description) {
          existing.description = description;
        }
      } else {
        byName.set(prop, {
          field: prop,
          type: type ?? "any",
          required: label,
          constraints: null,
          enum: null,
          default: undefined,
          description: description ?? null,
        });
      }
    }
  };

  if (logic?.or)
    logic.or.forEach((g) =>
      markGroup(g.properties, g.type, !!g.required, g.description ?? null),
    );

  if (logic?.and)
    logic.and.forEach((g) =>
      markGroup(g.properties, g.type, !!g.required, g.description ?? null),
    );

  return [...byName.values()];
}

function strongerRequired(current, incoming) {
  if (current === true) return true;
  if (typeof current !== "string") return incoming;
  return (REQUIRED_RANK[incoming] ?? 0) > (REQUIRED_RANK[current] ?? 0)
    ? incoming
    : current;
}

/*
 * ------------------------------------------------------------
 * Handler-file document rendering
 * ------------------------------------------------------------
 */

async function renderRouteFiles(built, docsRoot) {
  const apiDir = path.join(docsRoot, "api");

  await fs.mkdir(apiDir, { recursive: true });

  /*
   * Remove previously generated API markdown files, so stale
   * pages (v3.md, workflows_router.md, unresolved.md, etc.)
   * can never survive between generations.
   */
  const existingApiFiles = await collectMarkdownFiles(apiDir);

  for (const relativeFile of existingApiFiles) {
    const fullPath = path.join(apiDir, relativeFile);

    try {
      await fs.unlink(fullPath);
    } catch (error) {
      console.warn(`Failed to remove stale API document: ${fullPath}`, error);
    }
  }

  /*
   * Group routes by their ACTUAL HANDLER FILE, not their route file.
   */
  const byHandlerFile = new Map();

  for (const route of built) {
    const handlerFile = route.handler?.file;

    if (!handlerFile) {
      console.warn(`Skipping unresolved handler documentation: ${route.name}`);
      continue;
    }

    const normalizedHandlerFile = path.resolve(handlerFile);

    if (!(await exists(normalizedHandlerFile))) {
      console.warn(`Skipping missing handler file: ${normalizedHandlerFile}`);
      continue;
    }

    if (!byHandlerFile.has(normalizedHandlerFile)) {
      byHandlerFile.set(normalizedHandlerFile, []);
    }

    byHandlerFile.get(normalizedHandlerFile).push(route);
  }

  /*
   * Generate one Markdown file per handler source file.
   */
  const generatedDocuments = [];

  for (const [handlerFile, routes] of byHandlerFile.entries()) {
    const originalFileName = path.basename(
      handlerFile,
      path.extname(handlerFile),
    );
    const fileName = sanitizeDocFileName(originalFileName);

    if (!fileName) {
      console.warn(
        `Skipping handler with invalid documentation filename: ${handlerFile}`,
      );
      continue;
    }

    const outputPath = path.join(apiDir, `${fileName}.md`);
    const lines = [`# ${capitalize(originalFileName)} API`, ""];

    const filePurpose = routes.map((r) => r.purpose).find(Boolean);
    lines.push(
      filePurpose
        ? escapeMarkdownValue(filePurpose)
        : "_No description was provided for this handler._",
    );
    lines.push("");

    lines.push("## Routes", "");

    /*
     * One pass per route: heading, endpoint line (when known),
     * purpose, then full detail directly beneath it.
     */
    for (const route of routes) {
      lines.push(`### ${route.name}`, "");

      /*
       * Only render an endpoint line when we actually have method
       * and/or path data. This codebase dispatches routes by action
       * name, not HTTP method + path, so for most handlers there is
       * nothing to show here — omit rather than print "N/A N/A".
       */
      if (route.method || route.path) {
        lines.push(
          `${escapeMarkdownValue(route.method ?? "")} ${escapeMarkdownValue(
            route.path ?? "",
          )}`.trim(),
        );
        lines.push("");
      }

      lines.push(
        route.purpose
          ? escapeMarkdownValue(route.purpose)
          : "_No description available._",
      );
      lines.push("");

      lines.push("#### Authentication", "");
      lines.push(describeAuthentication(route.security));
      lines.push("");

      lines.push("#### Request", "");
      lines.push(renderRequestSection(route.request));
      lines.push("");

      lines.push("#### Response", "");
      lines.push(
        "Returns the [standard response envelope](../api/#standard-response).",
      );
      lines.push("");

      const successEntries = route.response?.success ?? [];

      if (successEntries.length > 0) {
        lines.push("| Status Code | Message |", "| --- | --- |");

        for (const entry of successEntries) {
          lines.push(
            `| ${escapeMarkdownValue(entry.status_code ?? "—")} | ${escapeMarkdownValue(
              entry.message ?? "—",
            )} |`,
          );
        }

        lines.push("");
      } else {
        lines.push(
          "_No specific success status code or message could be determined for this route._",
        );
        lines.push("");
      }

      const responseFields = route.response?.data ?? [];

      if (responseFields.length > 0) {
        lines.push("##### Data", "");
        lines.push(renderResponseDataTable(responseFields));
        lines.push("");
      }

      if (
        Array.isArray(route.externalServices) &&
        route.externalServices.length > 0
      ) {
        lines.push("#### External Dependencies", "");
        lines.push(renderExternalDependenciesTable(route.externalServices));
        lines.push("");
      }

      if (Array.isArray(route.errors) && route.errors.length > 0) {
        lines.push("#### Errors", "");
        lines.push(renderErrorsTable(route.errors));
        lines.push("");
      }

      lines.push("---", "");
    }

    await fs.writeFile(outputPath, `${lines.join("\n").trim()}\n`, "utf8");

    generatedDocuments.push({
      fileName,
      title: capitalize(originalFileName),
      path: outputPath,
      routes,
    });

    console.log(
      `Generated API document: ${path.relative(docsRoot, outputPath)}`,
    );
  }

  /*
   * ALWAYS generate api/index.md — sidebars.js links its category to it.
   */
  const indexLines = [
    "# API Reference",
    "",
    "This section contains the API documentation generated from the application's handler files.",
    "",
    "## Standard Response",
    "",
    "All handlers return this envelope.",
    "",
    "| Field | Type | Notes |",
    "| --- | --- | --- |",
    "| `ok` | `boolean` | |",
    "| `message` | `string` | |",
    "| `data` | `object \\| null` | |",
    "| `status_code` | `string` | Optional — not every response includes it |",
    "",
    "## Handlers",
    "",
  ];

  if (generatedDocuments.length === 0) {
    indexLines.push("_No resolved API handlers were found._", "");
  } else {
    for (const document of generatedDocuments) {
      indexLines.push(
        `- [${escapeMarkdownValue(document.title)}](/docs/api/${document.fileName})`,
      );
    }
    indexLines.push("");
  }

  const indexPath = path.join(apiDir, "index.md");
  await fs.writeFile(indexPath, `${indexLines.join("\n").trim()}\n`, "utf8");
  console.log(`Generated API index: ${path.relative(docsRoot, indexPath)}`);
}

/*
 * Maps the raw `security` value from the route scanner to a display
 * label. Falls back to the raw value when it doesn't match a known
 * pattern, rather than guessing.
 */
function describeAuthentication(security) {
  if (!security) {
    return "None";
  }

  const value = String(security).trim();

  if (!value || /^none$/i.test(value)) {
    return "None";
  }

  if (/api[-_ ]?key/i.test(value)) {
    return "**API Key** — _see the Authentication guide (not yet published)._";
  }

  if (/bearer|jwt|token|auth/i.test(value)) {
    return "**Bearer Token** — _see the Authentication guide (not yet published)._";
  }

  return escapeMarkdownValue(value);
}

function renderRequestSection(request) {
  if (!request || !request.defined) {
    return "_No schema defined for this route — request shape is unvalidated._";
  }

  const hasParams =
    (Array.isArray(request.params) && request.params.length > 0) ||
    !!request.paramsLogic;

  const hasQuery =
    (Array.isArray(request.query) && request.query.length > 0) ||
    !!request.queryLogic;

  const parts = [];

  if (hasParams) {
    parts.push("**Path Parameters**", "");
    parts.push(
      renderFieldTable(
        mergeFieldsWithLogic(request.params ?? [], request.paramsLogic),
      ),
    );
    parts.push("");
  }

  if (hasQuery) {
    parts.push("**Query Parameters**", "");
    parts.push(
      renderFieldTable(
        mergeFieldsWithLogic(request.query ?? [], request.queryLogic),
      ),
    );
    parts.push("");
  }

  if (hasParams || hasQuery) {
    parts.push("**Body**", "");
  }

  parts.push(
    renderFieldTable(mergeFieldsWithLogic(request.body ?? [], request.logic)),
  );

  return parts.join("\n").trim();
}

function renderFieldTable(rows) {
  if (!rows || rows.length === 0) {
    return "_No fields could be determined for this section._";
  }

  const lines = [
    "| Field | Type | Required | Description |",
    "| --- | --- | --- | --- |",
  ];

  for (const row of rows) {
    const field = row?.field ?? row?.name ?? "unknown";
    const type = row?.type ?? "any";

    const required =
      row?.required === true
        ? "Yes"
        : row?.required
          ? escapeMarkdownValue(row.required)
          : "No";

    const description = describeFieldMeta(row);

    lines.push(
      `| \`${escapeMarkdownValue(field)}\` | \`${escapeMarkdownValue(
        type,
      )}\` | ${required} | ${escapeMarkdownValue(description)} |`,
    );
  }

  return lines.join("\n");
}

/*
 * Builds the Description-column text for a request field: leads with
 * the human-written `description` (falling back to any inferred
 * validation `constraints` when no description was given), then
 * appends `enum` and `default_value` as additional info whenever the
 * schema defines them, regardless of whether a description exists.
 */
function describeFieldMeta(row) {
  const segments = [];

  if (row?.description) {
    segments.push(row.description);
  } else if (row?.constraints) {
    segments.push(row.constraints);
  }

  if (Array.isArray(row?.enum) && row.enum.length > 0) {
    segments.push(`Allowed: ${row.enum.join(", ")}`);
  }

  if (
    row?.default !== undefined &&
    row?.default !== null &&
    row?.default !== ""
  ) {
    segments.push(`Default: ${formatDefaultValue(row.default)}`);
  }

  return segments.length > 0 ? segments.join(" — ") : "";
}

function formatDefaultValue(value) {
  if (typeof value === "string") {
    return `\`${value}\``;
  }

  if (typeof value === "object") {
    try {
      return `\`${JSON.stringify(value)}\``;
    } catch {
      return "—";
    }
  }

  return `\`${value}\``;
}

function renderResponseDataTable(fields) {
  const lines = ["| Field | Type | Description |", "| --- | --- | --- |"];

  for (const field of fields) {
    if (typeof field === "string") {
      lines.push(`| \`${escapeMarkdownValue(field)}\` | — | — |`);
      continue;
    }

    const name = field?.field ?? field?.name ?? "unknown";
    const type = field?.type ?? "any";
    const description = field?.description ?? "—";

    lines.push(
      `| \`${escapeMarkdownValue(name)}\` | \`${escapeMarkdownValue(
        type,
      )}\` | ${escapeMarkdownValue(description)} |`,
    );
  }

  return lines.join("\n");
}

function renderExternalDependenciesTable(services) {
  const lines = ["| Service | Operation | Purpose |", "| --- | --- | --- |"];

  for (const service of services) {
    if (typeof service === "string") {
      lines.push(`| ${escapeMarkdownValue(service)} | — | — |`);
      continue;
    }

    const name = service?.service ?? service?.name ?? "Unknown";
    const operation = service?.method ?? "—";
    const purpose = service?.context ?? "—";

    lines.push(
      `| ${escapeMarkdownValue(name)} | ${escapeMarkdownValue(
        operation,
      )} | ${escapeMarkdownValue(purpose)} |`,
    );
  }

  return lines.join("\n");
}

function renderErrorsTable(errors) {
  const lines = ["| Status | Code | Description |", "| --- | --- | --- |"];

  for (const error of errors) {
    if (typeof error === "string") {
      lines.push(`| — | — | ${escapeMarkdownValue(error)} |`);
      continue;
    }

    const status = error?.status ?? "—";
    const code = error?.status_code ?? error?.code ?? "—";
    const description =
      error?.meaning ?? error?.message ?? error?.description ?? "—";

    lines.push(
      `| ${escapeMarkdownValue(status)} | ${escapeMarkdownValue(
        code,
      )} | ${escapeMarkdownValue(description)} |`,
    );
  }

  return lines.join("\n");
}

/*
 * ------------------------------------------------------------
 * Shared helpers
 * ------------------------------------------------------------
 */

async function collectMarkdownFiles(dir, relativeDir = "") {
  if (!(await exists(dir))) {
    return [];
  }

  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const absolutePath = path.join(dir, entry.name);
    const relativePath = path.join(relativeDir, entry.name);

    if (entry.isDirectory()) {
      files.push(...(await collectMarkdownFiles(absolutePath, relativePath)));
      continue;
    }

    if (entry.isFile() && /\.(md|mdx)$/i.test(entry.name)) {
      files.push(relativePath);
    }
  }

  return files;
}

function sanitizeDocFileName(value) {
  return String(value ?? "")
    .replace(/\.(md|mdx)$/i, "")
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
}

function capitalize(value) {
  return String(value ?? "")
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function escapeMarkdownValue(value) {
  if (value === null || value === undefined) {
    return "";
  }

  if (typeof value === "object") {
    try {
      return escapeMarkdownValue(JSON.stringify(value));
    } catch {
      return "";
    }
  }

  return String(value)
    .replace(/\|/g, "\\|")
    .replace(/\r?\n/g, " ")
    .replace(/\{/g, "\\{")
    .replace(/\}/g, "\\}")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

async function exists(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

async function renderRoutesJson(routes, docsRoot) {
  const agentsDir = path.join(docsRoot, "agents");
  await fs.mkdir(agentsDir, { recursive: true });

  const payload = routes.map((r) => ({
    $schema: "godprotocol/v1/route.schema.json",
    name: r.name,
    category: r.category,
    security: r.security,
    method: r.method,
    path: r.path,
    handler: r.handler
      ? {
          name: r.handler.name,
          file: relFile(r.handler.file),
          line: r.handler.line,
        }
      : null,
    request: {
      defined: r.request.defined,
      body: r.request.body,
      logic: r.request.logic,
      query: r.request.query,
      queryLogic: r.request.queryLogic,
      params: r.request.params,
      paramsLogic: r.request.paramsLogic,
      confidence: r.request.confidence,
    },
    response: r.response,
    externalServices: r.externalServices,
    errors: r.errors,
    confidence: "extracted",
  }));

  await fs.writeFile(
    path.join(agentsDir, "routes.json"),
    JSON.stringify(payload, null, 2),
  );
}

function relFile(file) {
  return file ? path.relative(process.cwd(), file) : "unresolved";
}
