import fs from "node:fs/promises";
import path from "node:path";

export async function scanEnv(projectRoot) {
  const candidates = [".env.example", ".env"];
  const found = [];
  const seen = new Set();

  for (const file of candidates) {
    const full = path.join(projectRoot, file);
    try {
      const text = await fs.readFile(full, "utf8");
      let pendingComment = null;
      for (const line of text.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) {
          if (trimmed.startsWith("#")) {
            pendingComment = trimmed.replace(/^#\s*/, "");
          }
          continue;
        }
        const eq = trimmed.indexOf("=");
        if (eq === -1) continue;
        const name = trimmed.slice(0, eq).trim();
        if (seen.has(name)) continue;
        seen.add(name);
        const value = trimmed.slice(eq + 1).trim();
        found.push({
          name,
          value: value || undefined,
          comment: pendingComment,
          required: !value || value === '""' || value === "''",
          source: file,
        });
        pendingComment = null;
      }
    } catch {
      // missing file is fine
    }
  }
  return found;
}

export async function scanServicesConfig(projectRoot) {
  const full = path.join(projectRoot, "services.config.js");
  try {
    await fs.access(full);
    return { path: full };
  } catch {
    return null;
  }
}
