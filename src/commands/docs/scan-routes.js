import fs from "node:fs/promises";
import path from "node:path";
import { extractSchemaObject } from "./scan-schema.js";

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export async function scanRouterFiles(projectRoot) {
  const routesDir = path.join(projectRoot, "routes");

  console.log("routesDir:", routesDir);

  if (!(await exists(routesDir))) {
    console.log("routes directory not found:", routesDir);
    return [];
  }

  const files = await collectJsFiles(routesDir);

  console.log("route files:", files);

  const results = [];

  for (const file of files) {
    const fullPath = path.join(routesDir, file);

    let source;

    try {
      source = await fs.readFile(fullPath, "utf8");
    } catch (error) {
      console.warn(`Failed to read route file: ${fullPath}`, error);
      continue;
    }

    const routeObject = extractRoutesObject(source);

    if (!routeObject || routeObject.length === 0) {
      console.log(`No routes found in: ${fullPath}`);
      continue;
    }

    const imports = extractImports(source);

    const category =
      path.basename(file, path.extname(file)).replace(/^router-?/, "") ||
      "default";

    for (const [name, entry] of routeObject) {
      const resolved = await resolveHandler(
        entry.handler,
        imports,
        path.dirname(fullPath),
      );

      results.push({
        name,
        category,
        security: entry.security ?? null,
        schemaRaw: entry.schemaRaw ?? null,
        routeFile: fullPath,
        handler: resolved,
      });
    }
  }

  console.log(`Found ${results.length} routes`);

  return results;
}

function parseRouteEntries(text) {
  const entries = splitTopLevelEntries(text);
  const parsed = [];

  for (const entry of entries) {
    const trimmed = entry.trim();

    if (!trimmed) {
      continue;
    }

    /*
     * Supported:
     *
     * foo: {
     *   handler: foo
     * }
     *
     * "foo": {
     *   handler: foo
     * }
     *
     * 'foo': {
     *   handler: foo
     * }
     *
     * `foo`: {
     *   handler: foo
     * }
     */
    const keyMatch = trimmed.match(
      /^(?:"([^"]+)"|'([^']+)'|`([^`]+)`|([A-Za-z_$][\w$]*))\s*:\s*\{/,
    );

    if (!keyMatch) {
      continue;
    }

    const name = keyMatch[1] ?? keyMatch[2] ?? keyMatch[3] ?? keyMatch[4];

    const bodyOpenIndex = keyMatch.index + keyMatch[0].lastIndexOf("{");

    const balanced = readBalanced(trimmed, bodyOpenIndex, "{", "}");

    if (balanced.text === null) {
      continue;
    }

    const bodyText = balanced.text;

    /*
     * handler: foo
     * handler: foo_bar
     * handler: $foo
     */
    const handlerMatch = bodyText.match(
      /\bhandler\s*:\s*([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)?)/,
    );

    /*
     * security: "auth"
     * security: 'auth'
     * security: `auth`
     */
    const securityMatch = bodyText.match(
      /\bsecurity\s*:\s*(?:"([^"]+)"|'([^']+)'|`([^`]+)`)/,
    );

    /*
     * schema: {
     *   body: {
     *     ...
     *   }
     * }
     */
    const schemaBlock = extractSchemaObject(bodyText);

    parsed.push([
      name,
      {
        handler: handlerMatch ? handlerMatch[1] : null,

        security: securityMatch
          ? (securityMatch[1] ?? securityMatch[2] ?? securityMatch[3])
          : null,

        schemaRaw: schemaBlock?.raw ?? null,
      },
    ]);
  }

  return parsed;
}

function extractRoutesObject(source) {
  const declarations = [
    // const routes = { ... }
    /\b(?:const|let|var)\s+routes\s*=\s*\{/g,

    // export const routes = { ... }
    /\bexport\s+(?:const|let|var)\s+routes\s*=\s*\{/g,

    // const router = { ... }
    /\b(?:const|let|var)\s+router\s*=\s*\{/g,

    // export const router = { ... }
    /\bexport\s+(?:const|let|var)\s+router\s*=\s*\{/g,

    // export default { ... }
    /\bexport\s+default\s*\{/g,
  ];

  for (const pattern of declarations) {
    const match = pattern.exec(source);

    if (!match) {
      continue;
    }

    const openBraceIndex = match.index + match[0].lastIndexOf("{");

    const balanced = readBalanced(source, openBraceIndex, "{", "}");

    if (balanced.text === null) {
      continue;
    }

    const parsed = parseRouteEntries(balanced.text);

    if (parsed.length > 0) {
      return parsed;
    }
  }

  /*
   * Handle:
   *
   * const routes = someRoutes;
   * export default routes;
   *
   * In that case, locate the object assigned to the identifier.
   */
  const identifierPatterns = [
    /\b(?:const|let|var)\s+routes\s*=\s*([A-Za-z_$][\w$]*)\s*;/,
    /\b(?:const|let|var)\s+router\s*=\s*([A-Za-z_$][\w$]*)\s*;/,
    /\bexport\s+default\s+([A-Za-z_$][\w$]*)\s*;/,
  ];

  for (const pattern of identifierPatterns) {
    const match = source.match(pattern);

    if (!match) {
      continue;
    }

    const identifier = match[1];

    const objectPattern = new RegExp(
      `\\b(?:const|let|var)\\s+${escapeRegExp(identifier)}\\s*=\\s*\\{`,
    );

    const objectMatch = source.match(objectPattern);

    if (!objectMatch) {
      continue;
    }

    const openBraceIndex = objectMatch.index + objectMatch[0].lastIndexOf("{");

    const balanced = readBalanced(source, openBraceIndex, "{", "}");

    if (balanced.text === null) {
      continue;
    }

    const parsed = parseRouteEntries(balanced.text);

    if (parsed.length > 0) {
      return parsed;
    }
  }

  return null;
}

function extractImports(source) {
  const imports = [];

  /*
   * Named imports:
   *
   * import { foo } from "./foo.js";
   * import { foo as bar } from "./foo.js";
   */
  const namedPattern = /import\s*\{([\s\S]*?)\}\s*from\s*["']([^"']+)["']/g;

  let match;

  while ((match = namedPattern.exec(source))) {
    const names = match[1]
      .split(",")
      .map((name) => name.trim())
      .filter(Boolean);

    for (const rawName of names) {
      const parts = rawName.split(/\s+as\s+/).map((part) => part.trim());

      const importedName = parts[0];
      const localName = parts[1] ?? importedName;

      imports.push({
        name: localName,
        importedName,
        from: match[2],
      });
    }
  }

  /*
   * Default imports:
   *
   * import foo from "./foo.js";
   */
  const defaultPattern =
    /import\s+([A-Za-z_$][\w$]*)\s+from\s*["']([^"']+)["']/g;

  while ((match = defaultPattern.exec(source))) {
    imports.push({
      name: match[1],
      importedName: "default",
      from: match[2],
    });
  }

  /*
   * Namespace imports:
   *
   * import * as handlers from "./handlers.js";
   *
   * We record the namespace itself. This is useful later if
   * a handler is referenced as handlers.foo.
   */
  const namespacePattern =
    /import\s+\*\s+as\s+([A-Za-z_$][\w$]*)\s+from\s*["']([^"']+)["']/g;

  while ((match = namespacePattern.exec(source))) {
    imports.push({
      name: match[1],
      importedName: "*",
      from: match[2],
      namespace: true,
    });
  }

  return imports;
}

async function resolveHandler(identifier, imports, baseDir) {
  if (!identifier) {
    return null;
  }

  /*
   * Support:
   *
   * handler: createChatSession
   */
  const directImport = imports.find((item) => item.name === identifier);

  if (directImport) {
    const handlerFile = await resolveModuleFile(baseDir, directImport.from);

    if (!handlerFile) {
      return {
        name: identifier,
        file: directImport.from,
        source: null,
        line: null,
      };
    }

    const source = await fs.readFile(handlerFile, "utf8");

    const extracted = extractFunctionSource(
      source,
      directImport.importedName === "default"
        ? "default"
        : (directImport.importedName ?? identifier),
    );

    return {
      name: identifier,
      file: handlerFile,
      line: extracted?.line ?? null,
      source: extracted?.body ?? null,
    };
  }

  /*
   * Support:
   *
   * handler: handlers.createChatSession
   */
  const memberMatch = identifier.match(
    /^([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)$/,
  );

  if (memberMatch) {
    const namespaceName = memberMatch[1];
    const memberName = memberMatch[2];

    const namespaceImport = imports.find(
      (item) => item.name === namespaceName && item.namespace === true,
    );

    if (namespaceImport) {
      const handlerFile = await resolveModuleFile(
        baseDir,
        namespaceImport.from,
      );

      if (!handlerFile) {
        return {
          name: identifier,
          file: namespaceImport.from,
          source: null,
          line: null,
        };
      }

      const source = await fs.readFile(handlerFile, "utf8");

      const extracted = extractFunctionSource(source, memberName);

      return {
        name: identifier,
        file: handlerFile,
        line: extracted?.line ?? null,
        source: extracted?.body ?? null,
      };
    }
  }

  /*
   * Handler isn't imported. Keep it unresolved rather than
   * throwing and stopping documentation generation.
   */
  return {
    name: identifier,
    file: null,
    source: null,
    line: null,
  };
}

async function resolveModuleFile(baseDir, modulePath) {
  if (!modulePath.startsWith(".")) {
    return null;
  }

  const base = path.resolve(baseDir, modulePath);

  const candidates = [
    base,
    `${base}.js`,
    `${base}.mjs`,
    `${base}.cjs`,
    `${base}.ts`,
    `${base}.tsx`,
    path.join(base, "index.js"),
    path.join(base, "index.ts"),
  ];

  for (const candidate of candidates) {
    if (await exists(candidate)) {
      return candidate;
    }
  }

  return null;
}

async function collectJsFiles(dir, relativeDir = "") {
  const entries = await fs.readdir(dir, {
    withFileTypes: true,
  });

  const files = [];

  for (const entry of entries) {
    const absolutePath = path.join(dir, entry.name);
    const relativePath = path.join(relativeDir, entry.name);

    if (entry.isDirectory()) {
      files.push(...(await collectJsFiles(absolutePath, relativePath)));

      continue;
    }

    if (entry.isFile() && /\.(js|mjs|cjs|ts|tsx)$/.test(entry.name)) {
      files.push(relativePath);
    }
  }

  return files;
}

function extractFunctionSource(source, name) {
  /*
   * Special handling for default exports.
   */
  if (name === "default") {
    const defaultPatterns = [
      /*
       * export default async function (...) {
       */
      /export\s+default\s+async\s+function\s*[A-Za-z_$]*\s*\([^)]*\)\s*\{/,

      /*
       * export default function (...) {
       */
      /export\s+default\s+function\s*[A-Za-z_$]*\s*\([^)]*\)\s*\{/,

      /*
       * export default async (...) => {
       */
      /export\s+default\s+async\s*\([^)]*\)\s*=>\s*\{/,
    ];

    for (const pattern of defaultPatterns) {
      const match = source.match(pattern);

      if (!match) {
        continue;
      }

      const openBraceIndex = match.index + match[0].lastIndexOf("{");

      const balanced = readBalanced(source, openBraceIndex, "{", "}");

      if (balanced.text === null) {
        continue;
      }

      const line = source.slice(0, match.index).split("\n").length;

      return {
        body: balanced.text,
        line,
      };
    }
  }

  const escapedName = escapeRegExp(name);

  const patterns = [
    /*
     * const foo = async (...) => {
     */
    new RegExp(
      `(?:const|let|var)\\s+${escapedName}\\s*=\\s*async\\s*\\([^)]*\\)\\s*=>\\s*\\{`,
    ),

    /*
     * const foo = (...) => {
     */
    new RegExp(
      `(?:const|let|var)\\s+${escapedName}\\s*=\\s*\\([^)]*\\)\\s*=>\\s*\\{`,
    ),

    /*
     * const foo = async arg => {
     */
    new RegExp(
      `(?:const|let|var)\\s+${escapedName}\\s*=\\s*async\\s+[A-Za-z_$][\\w$]*\\s*=>\\s*\\{`,
    ),

    /*
     * const foo = arg => {
     */
    new RegExp(
      `(?:const|let|var)\\s+${escapedName}\\s*=\\s*[A-Za-z_$][\\w$]*\\s*=>\\s*\\{`,
    ),

    /*
     * async function foo(...) {
     */
    new RegExp(`async\\s+function\\s+${escapedName}\\s*\\([^)]*\\)\\s*\\{`),

    /*
     * function foo(...) {
     */
    new RegExp(`function\\s+${escapedName}\\s*\\([^)]*\\)\\s*\\{`),

    /*
     * export async function foo(...) {
     */
    new RegExp(
      `export\\s+async\\s+function\\s+${escapedName}\\s*\\([^)]*\\)\\s*\\{`,
    ),

    /*
     * export function foo(...) {
     */
    new RegExp(`export\\s+function\\s+${escapedName}\\s*\\([^)]*\\)\\s*\\{`),
  ];

  for (const pattern of patterns) {
    const match = source.match(pattern);

    if (!match) {
      continue;
    }

    const openBraceIndex = match.index + match[0].lastIndexOf("{");

    const balanced = readBalanced(source, openBraceIndex, "{", "}");

    if (balanced.text === null) {
      continue;
    }

    const line = source.slice(0, match.index).split("\n").length;

    return {
      body: balanced.text,
      line,
    };
  }

  return null;
}

function readBalanced(source, openIndex, openChar, closeChar) {
  let depth = 0;
  let inString = null;
  for (let i = openIndex; i < source.length; i++) {
    const ch = source[i];
    if (inString) {
      if (ch === "\\") {
        i++;
        continue;
      }
      if (ch === inString) inString = null;
      continue;
    }
    if (ch === "/" && source[i + 1] === "/") {
      i = source.indexOf("\n", i);
      if (i === -1) break;
      continue;
    }
    if (ch === "/" && source[i + 1] === "*") {
      const end = source.indexOf("*/", i + 2);
      if (end === -1) break;
      i = end + 1;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      inString = ch;
      continue;
    }
    if (ch === openChar) depth++;
    if (ch === closeChar) {
      depth--;
      if (depth === 0)
        return { text: source.slice(openIndex + 1, i), endIndex: i };
    }
  }
  return { text: null, endIndex: -1 };
}

function splitTopLevelEntries(text) {
  const entries = [];
  let depth = 0;
  let inString = null;
  let current = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      current += ch;
      if (ch === "\\") {
        current += text[++i] ?? "";
        continue;
      }
      if (ch === inString) inString = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      inString = ch;
      current += ch;
      continue;
    }
    if (ch === "{" || ch === "(" || ch === "[") depth++;
    if (ch === "}" || ch === ")" || ch === "]") depth--;
    if (ch === "," && depth === 0) {
      entries.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim()) entries.push(current);
  return entries;
}

async function exists(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}
