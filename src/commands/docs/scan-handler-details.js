import fs from "node:fs/promises";
import path from "node:path";

/*
 * Handler/documentation scanner.
 *
 * IMPORTANT:
 * This intentionally does NOT use an AST dependency.
 *
 * The scanner uses a small JavaScript lexical/parser layer sufficient for
 * documentation extraction:
 *
 * - imports
 * - functions
 * - arrow functions
 * - returns
 * - object literals
 * - arrays
 * - service calls
 *
 * It only follows local imports.
 *
 * It NEVER follows:
 *
 *   node_modules
 *   package imports
 *   node:
 *   bare imports
 *
 * Circular imports/functions are protected by visited sets.
 */

const DEFAULT_MAX_FILES = 100;
const DEFAULT_MAX_FUNCTIONS = 500;
const DEFAULT_MAX_DEPTH = 20;

const JS_EXTENSIONS = [".js", ".mjs", ".cjs", ".jsx"];

export async function extractHandlerDetails(handlerBody, options = {}) {
  if (!handlerBody) {
    return {
      purpose: null,
      responseDataFields: [],
      errors: [],
      externalServices: [],
    };
  }

  const handlerFile = options.handlerFile
    ? path.resolve(options.handlerFile)
    : null;

  const projectRoot = options.projectRoot
    ? path.resolve(options.projectRoot)
    : handlerFile
      ? findProjectRoot(handlerFile)
      : process.cwd();

  const context = {
    projectRoot,

    maxFiles:
      Number(options.maxFiles) > 0
        ? Number(options.maxFiles)
        : DEFAULT_MAX_FILES,

    maxFunctions:
      Number(options.maxFunctions) > 0
        ? Number(options.maxFunctions)
        : DEFAULT_MAX_FUNCTIONS,

    maxDepth:
      Number(options.maxDepth) > 0
        ? Number(options.maxDepth)
        : DEFAULT_MAX_DEPTH,

    visitedFiles: new Set(),
    visitedFunctions: new Set(),

    files: new Map(),
    functions: new Map(),

    aliases: new Map(),

    responseFields: new Map(),
    errors: [],
    externalServices: [],

    currentFile: handlerFile,
  };

  /*
   * The handler itself must be scanned even when we don't know its
   * physical file. This gives us the normal non-recursive behaviour.
   */
  const handlerSource = stripSourceForScanning(handlerBody);

  if (handlerFile) {
    context.files.set(handlerFile, {
      file: handlerFile,
      source: handlerSource,
    });

    await discoverFile(handlerFile, handlerSource, context);
  } else {
    registerFunctionsFromSource(handlerSource, null, context);
  }

  /*
   * Register the handler source functions.
   */
  registerFunctionsFromSource(handlerSource, handlerFile, context);

  /*
   * Analyze the handler itself.
   */
  analyzeSource(handlerSource, handlerFile, context, 0);

  /*
   * Analyze all known functions that have been discovered.
   *
   * This is deliberately iterative instead of recursive over the function
   * list itself. That makes it much harder for circular code to lock us.
   */
  let processed = new Set();

  for (;;) {
    if (processed.size >= context.maxFunctions) {
      break;
    }

    const pending = [...context.functions.entries()].filter(
      ([key]) => !processed.has(key),
    );

    if (pending.length === 0) {
      break;
    }

    for (const [key, fn] of pending) {
      if (processed.size >= context.maxFunctions) {
        break;
      }

      processed.add(key);

      analyzeFunction(fn, context, 0);
    }
  }

  return {
    purpose: extractLeadingComment(handlerBody),

    responseDataFields: [...context.responseFields.values()].sort(
      compareResponseFields,
    ),

    errors: dedupeErrors(context.errors),

    externalServices: dedupeExternalServices(context.externalServices),
  };
}

/* -------------------------------------------------------------------------- */
/* FILE DISCOVERY                                                             */
/* -------------------------------------------------------------------------- */

async function discoverFile(file, source, context) {
  const resolved = path.resolve(file);

  if (context.visitedFiles.has(resolved)) {
    return;
  }

  if (context.visitedFiles.size >= context.maxFiles) {
    return;
  }

  context.visitedFiles.add(resolved);

  context.files.set(resolved, {
    file: resolved,
    source,
  });

  const imports = extractImports(source);

  for (const imported of imports) {
    if (!isLocalImport(imported.source)) {
      continue;
    }

    const importedFile = await resolveLocalImport(
      resolved,
      imported.source,
      context,
    );

    if (!importedFile) {
      continue;
    }

    let importedSource;

    try {
      importedSource = await fs.readFile(importedFile, "utf8");
    } catch {
      continue;
    }

    importedSource = stripSourceForScanning(importedSource);

    /*
     * Register aliases such as:
     *
     * import { buildSchedule as build } from "../helpers";
     */
    for (const specifier of imported.specifiers) {
      if (specifier.imported && specifier.local) {
        context.aliases.set(`${resolved}:${specifier.local}`, {
          importedName: specifier.imported,
          file: importedFile,
        });
      }

      if (specifier.default && specifier.local) {
        context.aliases.set(`${resolved}:${specifier.local}`, {
          importedName: "default",
          file: importedFile,
        });
      }

      if (specifier.namespace && specifier.local) {
        context.aliases.set(`${resolved}:${specifier.local}`, {
          importedName: "*",
          file: importedFile,
        });
      }
    }

    await discoverFile(importedFile, importedSource, context);

    registerFunctionsFromSource(importedSource, importedFile, context);
  }
}

function isLocalImport(source) {
  return (
    typeof source === "string" &&
    (source.startsWith("./") ||
      source.startsWith("../") ||
      source === "." ||
      source === "..")
  );
}

async function resolveLocalImport(importer, importPath, context) {
  if (!isLocalImport(importPath)) {
    return null;
  }

  const importerDir = path.dirname(importer);

  const absolute = path.resolve(importerDir, importPath);

  /*
   * Never permit a local import to resolve into node_modules.
   */
  const nodeModulesSegment = `${path.sep}node_modules${path.sep}`;

  if (absolute.includes(nodeModulesSegment)) {
    return null;
  }

  const candidates = [];

  if (path.extname(absolute)) {
    candidates.push(absolute);
  } else {
    for (const ext of JS_EXTENSIONS) {
      candidates.push(`${absolute}${ext}`);
    }

    for (const ext of JS_EXTENSIONS) {
      candidates.push(path.join(absolute, `index${ext}`));
    }
  }

  for (const candidate of candidates) {
    if (await exists(candidate)) {
      return path.resolve(candidate);
    }
  }

  return null;
}

/* -------------------------------------------------------------------------- */
/* IMPORTS                                                                    */
/* -------------------------------------------------------------------------- */

function extractImports(source) {
  const imports = [];

  /*
   * import x from "./x";
   * import { a, b as c } from "./x";
   * import * as x from "./x";
   */
  const importRegex = /\bimport\s+([\s\S]*?)\s+from\s+["']([^"']+)["']/g;

  let match;

  while ((match = importRegex.exec(source))) {
    imports.push({
      source: match[2],
      specifiers: parseImportSpecifiers(match[1]),
    });
  }

  /*
   * import "./side-effect";
   */
  const sideEffectRegex = /\bimport\s*["']([^"']+)["']/g;

  while ((match = sideEffectRegex.exec(source))) {
    imports.push({
      source: match[1],
      specifiers: [],
    });
  }

  /*
   * const x = require("./x")
   *
   * This is only followed when the require path is local.
   */
  const requireRegex = /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g;

  while ((match = requireRegex.exec(source))) {
    imports.push({
      source: match[1],
      specifiers: [],
    });
  }

  return imports;
}

function parseImportSpecifiers(text) {
  const result = [];

  let value = text.trim();

  /*
   * Default import:
   *
   * import foo from "./foo"
   */
  if (!value.startsWith("{") && !value.startsWith("*")) {
    const comma = value.indexOf(",");

    const local = comma === -1 ? value.trim() : value.slice(0, comma).trim();

    if (local) {
      result.push({
        default: true,
        local,
      });
    }

    if (comma !== -1) {
      value = value.slice(comma + 1).trim();
    } else {
      return result;
    }
  }

  /*
   * Namespace:
   *
   * import * as foo from "./foo"
   */
  if (value.startsWith("*")) {
    const match = value.match(/\*\s+as\s+([A-Za-z_$][\w$]*)/);

    if (match) {
      result.push({
        namespace: true,
        local: match[1],
      });
    }

    return result;
  }

  /*
   * Named:
   *
   * import { foo, bar as baz } from "./foo"
   */
  const start = value.indexOf("{");

  const end = value.lastIndexOf("}");

  if (start !== -1 && end !== -1) {
    const inside = value.slice(start + 1, end);

    for (const item of splitTopLevel(inside, ",")) {
      const part = item.trim();

      if (!part) continue;

      const pieces = part.split(/\s+as\s+/).map((x) => x.trim());

      result.push({
        imported: pieces[0],
        local: pieces[1] ?? pieces[0],
      });
    }
  }

  return result;
}

/* -------------------------------------------------------------------------- */
/* FUNCTION DISCOVERY                                                         */
/* -------------------------------------------------------------------------- */

function registerFunctionsFromSource(source, file, context) {
  if (!source || context.functions.size >= context.maxFunctions) {
    return;
  }

  /*
   * function foo(...) { ... }
   */
  const declarationRegex = /\b(?:async\s+)?function\s*([A-Za-z_$][\w$]*)\s*\(/g;

  let match;

  while ((match = declarationRegex.exec(source))) {
    const name = match[1];

    const openParen = source.indexOf("(", match.index);

    const closeParen = findMatchingClose(source, openParen, "(", ")");

    if (closeParen === -1) {
      continue;
    }

    const openBrace = findNextCodeChar(source, closeParen + 1, "{");

    if (openBrace === -1) {
      continue;
    }

    const closeBrace = findMatchingClose(source, openBrace, "{", "}");

    if (closeBrace === -1) {
      continue;
    }

    const params = source.slice(openParen + 1, closeParen);

    const body = source.slice(openBrace + 1, closeBrace);

    registerFunction(context, {
      name,
      file,
      params,
      body,
      kind: "function",
    });
  }

  /*
   * const foo = (...) => { ... }
   * let foo = (...) => ({ ... })
   */
  const arrowRegex =
    /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/g;

  while ((match = arrowRegex.exec(source))) {
    const name = match[1];
    const paramsText = match[2];

    const arrowIndex = source.indexOf("=>", match.index);

    if (arrowIndex === -1) {
      continue;
    }

    let cursor = skipWhitespaceAndComments(source, arrowIndex + 2);

    let body = "";

    if (source[cursor] === "{") {
      const closeBrace = findMatchingClose(source, cursor, "{", "}");

      if (closeBrace === -1) {
        continue;
      }

      body = source.slice(cursor + 1, closeBrace);
    } else if (source[cursor] === "(") {
      const closeParen = findMatchingClose(source, cursor, "(", ")");

      if (closeParen === -1) {
        continue;
      }

      body = `return ${source.slice(cursor + 1, closeParen)};`;
    } else {
      const end = findExpressionEnd(source, cursor);

      body = `return ${source.slice(cursor, end)};`;
    }

    const params = paramsText.startsWith("(")
      ? paramsText.slice(1, -1)
      : paramsText;

    registerFunction(context, {
      name,
      file,
      params,
      body,
      kind: "arrow",
    });
  }

  /*
   * exports.foo = function (...) {}
   * module.exports.foo = function (...) {}
   */
  const exportedFunctionRegex =
    /\b(?:exports|module\.exports)\.([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?function\s*\(/g;

  while ((match = exportedFunctionRegex.exec(source))) {
    const name = match[1];

    const openParen = source.indexOf("(", match.index);

    const closeParen = findMatchingClose(source, openParen, "(", ")");

    if (closeParen === -1) {
      continue;
    }

    const openBrace = findNextCodeChar(source, closeParen + 1, "{");

    if (openBrace === -1) {
      continue;
    }

    const closeBrace = findMatchingClose(source, openBrace, "{", "}");

    if (closeBrace === -1) {
      continue;
    }

    registerFunction(context, {
      name,
      file,
      params: source.slice(openParen + 1, closeParen),
      body: source.slice(openBrace + 1, closeBrace),
      kind: "exported-function",
    });
  }
}

function registerFunction(context, fn) {
  if (!fn.name || context.functions.size >= context.maxFunctions) {
    return;
  }

  const key = `${fn.file ?? "<inline>"}:${fn.name}`;

  if (context.functions.has(key)) {
    return;
  }

  context.functions.set(key, {
    ...fn,
    key,
  });
}

/* -------------------------------------------------------------------------- */
/* ANALYSIS                                                                   */
/* -------------------------------------------------------------------------- */

function analyzeSource(source, file, context, depth) {
  if (!source || depth > context.maxDepth) {
    return;
  }

  analyzeReturns(source, file, context, depth);

  analyzeErrors(source, file, context);

  analyzeExternalServices(source, file, context);

  /*
   * Find calls to known functions and make sure their returned structures
   * are available to the response shape.
   */
  const calls = extractFunctionCalls(source);

  for (const call of calls) {
    resolveAndAnalyzeFunction(call.name, file, context, depth + 1);
  }
}

function analyzeFunction(fn, context, depth) {
  if (!fn || depth > context.maxDepth) {
    return;
  }

  const key = fn.key;

  /*
   * This is the primary circular-recursion protection.
   */
  if (context.visitedFunctions.has(key)) {
    return;
  }

  context.visitedFunctions.add(key);

  analyzeSource(fn.body, fn.file, context, depth);
}

function resolveAndAnalyzeFunction(name, currentFile, context, depth) {
  if (!name || depth > context.maxDepth) {
    return;
  }

  /*
   * Strip property access:
   *
   * helpers.build()
   *
   * We can still attempt to resolve "build".
   */
  const cleanName = name.includes(".") ? name.split(".").pop() : name;

  /*
   * First try a function in the current file.
   */
  const localKey = `${currentFile ?? "<inline>"}:${cleanName}`;

  const localFn = context.functions.get(localKey);

  if (localFn) {
    analyzeFunction(localFn, context, depth);
    return;
  }

  /*
   * Then look through imported aliases.
   */
  if (currentFile) {
    const alias = context.aliases.get(`${currentFile}:${cleanName}`);

    if (alias) {
      const targetKey = `${alias.file}:${alias.importedName}`;

      const importedFn = context.functions.get(targetKey);

      if (importedFn) {
        analyzeFunction(importedFn, context, depth);
        return;
      }

      /*
       * Default exports are often represented by a function named
       * "default" or by the basename of the file.
       */
      if (alias.importedName === "default") {
        const fallback = [...context.functions.values()].find(
          (fn) => fn.file === alias.file,
        );

        if (fallback) {
          analyzeFunction(fallback, context, depth);
        }
      }
    }
  }

  /*
   * Last resort: find a uniquely named function anywhere in our local
   * import graph.
   */
  const matches = [...context.functions.values()].filter(
    (fn) => fn.name === cleanName,
  );

  if (matches.length === 1) {
    analyzeFunction(matches[0], context, depth);
  }
}

/* -------------------------------------------------------------------------- */
/* RETURNS                                                                    */
/* -------------------------------------------------------------------------- */

function analyzeReturns(source, file, context, depth) {
  const returns = findReturnExpressions(source);

  for (const expression of returns) {
    const value = expression.expression.trim();

    /*
     * return {
     *   ...
     * }
     */
    if (value.startsWith("{")) {
      const object = parseObjectLiteral(value);

      if (object) {
        /*
         * A return object can itself be the StandardResponse:
         *
         * return {
         *   ok: true,
         *   status: 201,
         *   status_code: "CREATED_SUCCESS",
         *   data: ...
         * }
         */
        analyzeResponseObject(object, file, context, depth);
      }

      continue;
    }

    /*
     * return someHelper(...)
     *
     * We need to follow the helper.
     */
    const call = parseLeadingFunctionCall(value);

    if (call) {
      resolveAndAnalyzeFunction(call.name, file, context, depth + 1);
    }
  }
}

function analyzeResponseObject(object, file, context, depth) {
  if (!object) return;

  /*
   * Standard response:
   *
   * {
   *   ok: true,
   *   status: 201,
   *   status_code: "CREATED_SUCCESS",
   *   data: ...
   * }
   */
  const status = extractLiteralNumber(object.properties.status);

  const statusCode = extractLiteralString(object.properties.status_code);

  const data = object.properties.data;

  /*
   * If this looks like a standard response, analyze data specifically.
   */
  if (data !== undefined) {
    analyzeDataValue(data, file, context, depth + 1);
  }

  /*
   * Even if there is no data, status information is useful.
   */
  if (status !== null || statusCode !== null) {
    /*
     * Successful response metadata is not put into errors.
     */
  }
}

function analyzeDataValue(value, file, context, depth, prefix = "") {
  if (value === undefined || depth > context.maxDepth) {
    return;
  }

  /*
   * data: {
   *   id: user.id,
   *   profile: {
   *     name: user.name
   *   }
   * }
   */
  if (value.type === "object") {
    for (const [name, property] of Object.entries(value.properties)) {
      if (name === "...") {
        continue;
      }

      const fieldName = prefix ? `${prefix}.${name}` : name;

      const field = inferValueField(property, fieldName);

      mergeResponseField(context, field);

      if (property.type === "object") {
        analyzeDataValue(property, file, context, depth + 1, fieldName);
      }

      /*
       * data: {
       *   schedule: buildSchedule()
       * }
       */
      if (property.type === "call") {
        resolveAndAnalyzeFunction(property.name, file, context, depth + 1);
      }
    }

    return;
  }

  /*
   * data: someFunction()
   */
  if (value.type === "call") {
    const fn = resolveFunction(value.name, file, context);

    if (fn) {
      /*
       * Extract the helper's return object directly into data.
       */
      const returns = findReturnExpressions(fn.body);

      for (const expression of returns) {
        const returned = expression.expression.trim();

        if (returned.startsWith("{")) {
          const object = parseObjectLiteral(returned);

          if (object) {
            analyzeDataValue(
              object,
              file ?? fn.file,
              context,
              depth + 1,
              prefix,
            );
          }
        }

        const nestedCall = parseLeadingFunctionCall(returned);

        if (nestedCall) {
          analyzeDataValue(
            {
              type: "call",
              name: nestedCall.name,
            },
            fn.file,
            context,
            depth + 1,
            prefix,
          );
        }
      }
    }

    return;
  }

  /*
   * data: variable
   */
  if (value.type === "identifier") {
    const fn = resolveFunction(value.name, file, context);

    if (fn) {
      analyzeFunction(fn, context, depth + 1);

      const returns = findReturnExpressions(fn.body);

      for (const expression of returns) {
        const returned = expression.expression.trim();

        if (returned.startsWith("{")) {
          const object = parseObjectLiteral(returned);

          if (object) {
            analyzeDataValue(object, fn.file, context, depth + 1, prefix);
          }
        }
      }
    }
  }
}

function inferValueField(value, field) {
  if (!value) {
    return {
      field,
      type: "any",
      description: null,
    };
  }

  if (value.type === "string") {
    return {
      field,
      type: "string",
      description: null,
    };
  }

  if (value.type === "number") {
    return {
      field,
      type: "number",
      description: null,
    };
  }

  if (value.type === "boolean") {
    return {
      field,
      type: "boolean",
      description: null,
    };
  }

  if (value.type === "null") {
    return {
      field,
      type: "null",
      description: null,
    };
  }

  if (value.type === "array") {
    return {
      field,
      type: "array",
      description: null,
    };
  }

  if (value.type === "object") {
    return {
      field,
      type: "object",
      description: null,
    };
  }

  if (value.type === "call") {
    return {
      field,
      type: "object",
      description: null,
    };
  }

  return {
    field,
    type: "any",
    description: null,
  };
}

function mergeResponseField(context, field) {
  if (!field || !field.field) {
    return;
  }

  const existing = context.responseFields.get(field.field);

  if (!existing) {
    context.responseFields.set(field.field, field);
    return;
  }

  if (existing.type === "any" && field.type !== "any") {
    existing.type = field.type;
  }

  if (!existing.description && field.description) {
    existing.description = field.description;
  }
}

/* -------------------------------------------------------------------------- */
/* ERRORS                                                                     */
/* -------------------------------------------------------------------------- */

function analyzeErrors(source, file, context) {
  const returns = findReturnExpressions(source);

  for (const expression of returns) {
    const value = expression.expression.trim();

    if (!value.startsWith("{")) {
      continue;
    }

    const object = parseObjectLiteral(value);

    if (!object) continue;

    const status = extractLiteralNumber(object.properties.status);

    const statusCode = extractLiteralString(object.properties.status_code);

    const meaning =
      extractLiteralString(object.properties.message) ??
      extractLiteralString(object.properties.error) ??
      extractLiteralString(object.properties.detail);

    /*
     * Only treat an explicit HTTP error status as an error.
     */
    if (status !== null && status >= 400) {
      context.errors.push({
        status,
        status_code: statusCode,
        meaning: meaning ?? "not specified",
      });
    }
  }

  /*
   * throw new Error("...")
   */
  const throwRegex =
    /\bthrow\s+new\s+[A-Za-z_$][\w$]*\s*\(\s*(["'`])([\s\S]*?)\1\s*\)/g;

  let match;

  while ((match = throwRegex.exec(source))) {
    context.errors.push({
      status: null,
      status_code: null,
      meaning: match[2],
    });
  }
}

/* -------------------------------------------------------------------------- */
/* EXTERNAL SERVICES                                                          */
/* -------------------------------------------------------------------------- */

function analyzeExternalServices(source, file, context) {
  const serviceVariables = {};

  /*
   * const workflows = await services("workflows")
   */
  const serviceRegex =
    /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*await\s+services\s*\(\s*(["'`])([^"'`]+)\2\s*\)/g;

  let match;

  while ((match = serviceRegex.exec(source))) {
    serviceVariables[match[1]] = match[3];
  }

  /*
   * workflows.call("update_signal", {...})
   */
  const callRegex =
    /\b([A-Za-z_$][\w$]*)\s*\.\s*call\s*\(\s*(["'`])([^"'`]+)\2([\s\S]*?)\)/g;

  while ((match = callRegex.exec(source))) {
    const variable = match[1];

    const service = serviceVariables[variable];

    if (!service) continue;

    const method = match[3];

    const rawArguments = match[4]?.trim();

    context.externalServices.push({
      service,
      method,
      context: buildServiceArgumentContext(rawArguments),
    });
  }

  /*
   * Also support:
   *
   * services("workflows").call(...)
   */
  const directRegex =
    /\bservices\s*\(\s*(["'`])([^"'`]+)\1\s*\)\s*\.\s*call\s*\(\s*(["'`])([^"'`]+)\3([\s\S]*?)\)/g;

  while ((match = directRegex.exec(source))) {
    context.externalServices.push({
      service: match[2],
      method: match[4],
      context: buildServiceArgumentContext(match[5]?.trim()),
    });
  }
}

function buildServiceArgumentContext(raw) {
  if (!raw) {
    return null;
  }

  const cleaned = raw.trim();

  if (!cleaned) {
    return null;
  }

  /*
   * Keep the documentation useful without dumping enormous implementation
   * details into the generated page.
   */
  const normalized = cleaned.replace(/\s+/g, " ").slice(0, 500);

  return `Arguments: \`${normalized}\``;
}

/* -------------------------------------------------------------------------- */
/* PARSING HELPERS                                                            */
/* -------------------------------------------------------------------------- */

function findReturnExpressions(source) {
  const results = [];

  const regex = /\breturn\b/g;

  let match;

  while ((match = regex.exec(source))) {
    const start = skipWhitespaceAndComments(
      source,
      match.index + match[0].length,
    );

    const end = findExpressionEnd(source, start);

    results.push({
      start,
      end,
      expression: source.slice(start, end),
    });

    regex.lastIndex = end;
  }

  return results;
}

function extractFunctionCalls(source) {
  const results = [];

  const regex = /\b([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)?)\s*\(/g;

  let match;

  while ((match = regex.exec(source))) {
    const name = match[1];

    /*
     * Ignore obvious language/built-in constructs.
     */
    if (["if", "for", "while", "switch", "catch", "function"].includes(name)) {
      continue;
    }

    results.push({
      name,
      index: match.index,
    });
  }

  return results;
}

function parseLeadingFunctionCall(value) {
  const match = value.match(/^([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)?)\s*\(/);

  if (!match) {
    return null;
  }

  return {
    name: match[1],
  };
}

function resolveFunction(name, file, context) {
  if (!name) {
    return null;
  }

  const clean = name.includes(".") ? name.split(".").pop() : name;

  const local = context.functions.get(`${file ?? "<inline>"}:${clean}`);

  if (local) {
    return local;
  }

  if (file) {
    const alias = context.aliases.get(`${file}:${clean}`);

    if (alias) {
      const imported = context.functions.get(
        `${alias.file}:${alias.importedName}`,
      );

      if (imported) {
        return imported;
      }

      if (alias.importedName === "default") {
        return (
          [...context.functions.values()].find(
            (fn) => fn.file === alias.file,
          ) ?? null
        );
      }
    }
  }

  const matches = [...context.functions.values()].filter(
    (fn) => fn.name === clean,
  );

  return matches.length === 1 ? matches[0] : null;
}

function parseObjectLiteral(text) {
  const source = text.trim();

  if (!source.startsWith("{")) {
    return null;
  }

  const close = findMatchingClose(source, 0, "{", "}");

  if (close === -1) {
    return null;
  }

  const inside = source.slice(1, close);

  const properties = {};

  for (const part of splitTopLevel(inside, ",")) {
    const property = parseObjectProperty(part);

    if (!property) continue;

    properties[property.name] = property.value;
  }

  return {
    type: "object",
    properties,
  };
}

function parseObjectProperty(text) {
  const source = text.trim();

  if (!source) return null;

  /*
   * Spread.
   */
  if (source.startsWith("...")) {
    return {
      name: "...",
      value: {
        type: "spread",
        name: source.slice(3).trim(),
      },
    };
  }

  /*
   * key: value
   */
  const colon = findTopLevelColon(source);

  if (colon !== -1) {
    const rawName = source.slice(0, colon).trim();

    const rawValue = source.slice(colon + 1).trim();

    const name = normalizePropertyName(rawName);

    return {
      name,
      value: parseValue(rawValue),
    };
  }

  /*
   * shorthand:
   *
   * return { id, name }
   */
  const shorthand = source.match(/^[A-Za-z_$][\w$]*$/);

  if (shorthand) {
    return {
      name: shorthand[0],
      value: {
        type: "identifier",
        name: shorthand[0],
      },
    };
  }

  return null;
}

function parseValue(value) {
  const text = value.trim();

  if (!text) {
    return {
      type: "any",
    };
  }

  if (text.startsWith("{")) {
    return (
      parseObjectLiteral(text) ?? {
        type: "object",
      }
    );
  }

  if (text.startsWith("[")) {
    return {
      type: "array",
    };
  }

  if (/^["'`]/.test(text)) {
    const string = parseQuotedString(text);

    return string !== null
      ? {
          type: "string",
          value: string,
        }
      : {
          type: "string",
        };
  }

  if (/^-?\d+(?:\.\d+)?$/.test(text)) {
    return {
      type: "number",
      value: Number(text),
    };
  }

  if (text === "true") {
    return {
      type: "boolean",
      value: true,
    };
  }

  if (text === "false") {
    return {
      type: "boolean",
      value: false,
    };
  }

  if (text === "null") {
    return {
      type: "null",
    };
  }

  const call = parseLeadingFunctionCall(text);

  if (call) {
    return {
      type: "call",
      name: call.name,
    };
  }

  const identifier = text.match(/^([A-Za-z_$][\w$]*)$/);

  if (identifier) {
    return {
      type: "identifier",
      name: identifier[1],
    };
  }

  return {
    type: "any",
  };
}

function extractLiteralNumber(value) {
  if (!value || value.type !== "number") {
    return null;
  }

  return value.value;
}

function extractLiteralString(value) {
  if (!value || value.type !== "string") {
    return null;
  }

  return value.value;
}

function normalizePropertyName(name) {
  const trimmed = name.trim();

  const quoted = parseQuotedString(trimmed);

  if (quoted !== null) {
    return quoted;
  }

  return trimmed.replace(/^['"`]|['"`]$/g, "");
}

function parseQuotedString(text) {
  if (!text) return null;

  const t = text.trim();

  if (t.length < 2) {
    return null;
  }

  const first = t[0];

  const last = t[t.length - 1];

  if ((first === '"' || first === "'" || first === "`") && first === last) {
    return t.slice(1, -1);
  }

  return null;
}

/* -------------------------------------------------------------------------- */
/* LEXICAL HELPERS                                                            */
/* -------------------------------------------------------------------------- */

function findMatchingClose(source, openIndex, openChar = "{", closeChar = "}") {
  let depth = 0;
  let inString = null;
  let inRegex = false;

  for (let i = openIndex; i < source.length; i++) {
    const ch = source[i];

    const next = source[i + 1];

    if (inString) {
      if (ch === "\\") {
        i++;
        continue;
      }

      if (ch === inString) {
        inString = null;
      }

      continue;
    }

    if (inRegex) {
      if (ch === "\\") {
        i++;
        continue;
      }

      if (ch === "/") {
        inRegex = false;
      }

      continue;
    }

    if (ch === "/" && next === "/") {
      const end = source.indexOf("\n", i + 2);

      if (end === -1) {
        break;
      }

      i = end;
      continue;
    }

    if (ch === "/" && next === "*") {
      const end = source.indexOf("*/", i + 2);

      if (end === -1) {
        break;
      }

      i = end + 1;
      continue;
    }

    if (ch === '"' || ch === "'" || ch === "`") {
      inString = ch;
      continue;
    }

    if (ch === openChar) {
      depth++;
      continue;
    }

    if (ch === closeChar) {
      depth--;

      if (depth === 0) {
        return i;
      }
    }
  }

  return -1;
}

function findNextCodeChar(source, start, wanted) {
  let inString = null;

  for (let i = start; i < source.length; i++) {
    const ch = source[i];

    if (inString) {
      if (ch === "\\") {
        i++;
        continue;
      }

      if (ch === inString) {
        inString = null;
      }

      continue;
    }

    if (ch === '"' || ch === "'" || ch === "`") {
      inString = ch;
      continue;
    }

    if (ch === wanted) {
      return i;
    }
  }

  return -1;
}

function findExpressionEnd(source, start) {
  let brace = 0;
  let bracket = 0;
  let paren = 0;
  let string = null;

  for (let i = start; i < source.length; i++) {
    const ch = source[i];

    if (string) {
      if (ch === "\\") {
        i++;
        continue;
      }

      if (ch === string) {
        string = null;
      }

      continue;
    }

    if (ch === '"' || ch === "'" || ch === "`") {
      string = ch;
      continue;
    }

    if (ch === "{") brace++;
    if (ch === "}") {
      if (brace > 0) brace--;
    }

    if (ch === "[") bracket++;
    if (ch === "]") {
      if (bracket > 0) bracket--;
    }

    if (ch === "(") paren++;
    if (ch === ")") {
      if (paren > 0) paren--;
    }

    if (
      (ch === ";" || ch === "\n") &&
      brace === 0 &&
      bracket === 0 &&
      paren === 0
    ) {
      return i;
    }
  }

  return source.length;
}

function splitTopLevel(source, separator) {
  const result = [];

  let start = 0;

  let brace = 0;
  let bracket = 0;
  let paren = 0;
  let string = null;

  for (let i = 0; i < source.length; i++) {
    const ch = source[i];

    if (string) {
      if (ch === "\\") {
        i++;
        continue;
      }

      if (ch === string) {
        string = null;
      }

      continue;
    }

    if (ch === '"' || ch === "'" || ch === "`") {
      string = ch;
      continue;
    }

    if (ch === "{") brace++;
    if (ch === "}") brace--;

    if (ch === "[") bracket++;
    if (ch === "]") bracket--;

    if (ch === "(") paren++;
    if (ch === ")") paren--;

    if (ch === separator && brace === 0 && bracket === 0 && paren === 0) {
      result.push(source.slice(start, i));

      start = i + 1;
    }
  }

  result.push(source.slice(start));

  return result;
}

function findTopLevelColon(source) {
  let brace = 0;
  let bracket = 0;
  let paren = 0;
  let string = null;

  for (let i = 0; i < source.length; i++) {
    const ch = source[i];

    if (string) {
      if (ch === "\\") {
        i++;
        continue;
      }

      if (ch === string) {
        string = null;
      }

      continue;
    }

    if (ch === '"' || ch === "'" || ch === "`") {
      string = ch;
      continue;
    }

    if (ch === "{") brace++;
    if (ch === "}") brace--;

    if (ch === "[") bracket++;
    if (ch === "]") bracket--;

    if (ch === "(") paren++;
    if (ch === ")") paren--;

    if (ch === ":" && brace === 0 && bracket === 0 && paren === 0) {
      return i;
    }
  }

  return -1;
}

function skipWhitespaceAndComments(source, start) {
  let i = start;

  while (i < source.length) {
    while (/\s/.test(source[i] ?? "")) {
      i++;
    }

    if (source[i] === "/" && source[i + 1] === "/") {
      const end = source.indexOf("\n", i + 2);

      if (end === -1) {
        return source.length;
      }

      i = end;
      continue;
    }

    if (source[i] === "/" && source[i + 1] === "*") {
      const end = source.indexOf("*/", i + 2);

      if (end === -1) {
        return source.length;
      }

      i = end + 2;
      continue;
    }

    break;
  }

  return i;
}

function stripSourceForScanning(source) {
  /*
   * We intentionally preserve strings because returned string literals
   * such as:
   *
   * status_code: "CREATED_SUCCESS"
   *
   * are useful.
   *
   * Comments are removed separately by replacing their contents with
   * whitespace, preserving indexes reasonably well.
   */
  let result = "";

  let string = null;

  for (let i = 0; i < source.length; i++) {
    const ch = source[i];

    const next = source[i + 1];

    if (string) {
      result += ch;

      if (ch === "\\") {
        if (i + 1 < source.length) {
          result += source[++i];
        }

        continue;
      }

      if (ch === string) {
        string = null;
      }

      continue;
    }

    if (ch === '"' || ch === "'" || ch === "`") {
      string = ch;
      result += ch;
      continue;
    }

    if (ch === "/" && next === "/") {
      result += "  ";

      i += 2;

      while (i < source.length && source[i] !== "\n") {
        result += " ";
        i++;
      }

      if (i < source.length) {
        result += "\n";
      }

      continue;
    }

    if (ch === "/" && next === "*") {
      result += "  ";

      i += 2;

      while (i < source.length) {
        if (source[i] === "*" && source[i + 1] === "/") {
          result += "  ";
          i++;
          break;
        }

        result += source[i] === "\n" ? "\n" : " ";

        i++;
      }

      continue;
    }

    result += ch;
  }

  return result;
}

/* -------------------------------------------------------------------------- */
/* COMMENTS                                                                   */
/* -------------------------------------------------------------------------- */

function extractLeadingComment(body) {
  if (!body) {
    return null;
  }

  const lineMatch = body.match(/^\s*\/\/\s*(.+?)(?:\r?\n|$)/);

  if (lineMatch) {
    return lineMatch[1].trim();
  }

  const blockMatch = body.match(/^\s*\/\*\*?([\s\S]*?)\*\//);

  if (blockMatch) {
    return blockMatch[1]
      .split(/\r?\n/)
      .map((line) => line.replace(/^\s*\*\s?/, "").trim())
      .filter(Boolean)
      .join(" ");
  }

  return null;
}

/* -------------------------------------------------------------------------- */
/* SORTING / DEDUPE                                                           */
/* -------------------------------------------------------------------------- */

function compareResponseFields(a, b) {
  const depthA = String(a.field).split(".").length;

  const depthB = String(b.field).split(".").length;

  if (depthA !== depthB) {
    return depthA - depthB;
  }

  return String(a.field).localeCompare(String(b.field));
}

function dedupeErrors(errors) {
  const seen = new Set();
  const result = [];

  for (const error of errors) {
    const key = JSON.stringify({
      status: error.status ?? null,
      status_code: error.status_code ?? null,
      meaning: error.meaning ?? null,
    });

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    result.push(error);
  }

  return result;
}

function dedupeExternalServices(services) {
  const seen = new Set();
  const result = [];

  for (const service of services) {
    const key = JSON.stringify(service);

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    result.push(service);
  }

  return result;
}

function findProjectRoot(file) {
  let current = path.dirname(path.resolve(file));

  /*
   * Walk upwards until package.json.
   */
  for (;;) {
    if (current === path.dirname(current)) {
      break;
    }

    returnIfPackage: if (false) {
      // intentionally unreachable
    }

    current = path.dirname(current);

    break;
  }

  return process.cwd();
}

async function exists(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}
