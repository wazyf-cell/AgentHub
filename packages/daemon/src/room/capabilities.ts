import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative } from "node:path";

export interface SkillEntry {
  id: string;
  name: string;
  source: "claude" | "skill-library";
  category?: string;
  path: string;
  description?: string;
}

export interface McpEntry {
  name: string;
  source: "codex" | "claude";
}

export interface CapabilitiesManifest {
  scannedAt: string;
  skills: SkillEntry[];
  mcpServers: McpEntry[];
  missing: string[];
}

export interface ScanOptions {
  home?: string;
  workspace?: string;
  maxSkillsPerSource?: number;
}

export function scanCapabilities(options: ScanOptions = {}): CapabilitiesManifest {
  const home = options.home ?? homedir();
  const limit = options.maxSkillsPerSource ?? 500;
  const missing: string[] = [];

  const claudeSkillRoot = join(home, ".claude", "skills");
  const libraryRoot = join(home, ".skill-library", "skills");

  const skills: SkillEntry[] = [
    ...scanSkillDirectory(claudeSkillRoot, "claude", limit, missing),
    ...scanSkillDirectory(libraryRoot, "skill-library", limit, missing),
  ];

  const mcpServers: McpEntry[] = [
    ...scanCodexMcpServers(join(home, ".codex", "config.toml"), missing),
    ...scanClaudeMcpServers(join(home, ".claude.json"), missing),
  ];

  return {
    scannedAt: new Date().toISOString(),
    skills: dedupeBy(skills, (skill) => `${skill.source}:${skill.id}`),
    mcpServers: dedupeBy(mcpServers, (server) => server.name),
    missing,
  };
}

function scanSkillDirectory(
  root: string,
  source: SkillEntry["source"],
  limit: number,
  missing: string[],
): SkillEntry[] {
  if (!existsSync(root)) {
    missing.push(root);
    return [];
  }
  const files = findSkillFiles(root, limit);
  return files.map((file) => {
    const meta = readSkillMeta(file);
    const id = relative(root, dirname(file)).split(/[\\/]/).join("/");
    const segments = id.split("/");
    return {
      id: `${source}:${id}`,
      name: meta.name || basename(dirname(file)),
      source,
      category: segments.length > 1 ? segments[0] : undefined,
      path: file,
      description: meta.description,
    };
  });
}

function findSkillFiles(root: string, limit: number): string[] {
  const result: string[] = [];
  const walk = (directory: string): void => {
    if (result.length >= limit) return;
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (result.length >= limit) return;
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      const fullPath = join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.name === "SKILL.md") {
        result.push(fullPath);
      }
    }
  };
  walk(root);
  return result;
}

function readSkillMeta(file: string): { name?: string; description?: string } {
  let content: string;
  try {
    content = readFileSync(file, "utf8");
  } catch {
    return {};
  }
  const frontmatter = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!frontmatter) return {};
  const body = frontmatter[1];
  return {
    name: readFrontmatterValue(body, "name"),
    description: readFrontmatterValue(body, "description"),
  };
}

function readFrontmatterValue(body: string, key: string): string | undefined {
  const match = body.match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
  if (!match) return undefined;
  return match[1].trim().replace(/^["']|["']$/g, "") || undefined;
}

function scanCodexMcpServers(configPath: string, missing: string[]): McpEntry[] {
  if (!existsSync(configPath)) {
    missing.push(configPath);
    return [];
  }
  let content: string;
  try {
    content = readFileSync(configPath, "utf8");
  } catch {
    return [];
  }
  const names = new Set<string>();
  const pattern = /^\s*\[mcp_servers\.([A-Za-z0-9_.-]+)\]\s*$/gm;
  for (const match of content.matchAll(pattern)) {
    const name = match[1];
    if (name.includes(".")) continue;
    names.add(name);
  }
  return [...names].map((name) => ({ name, source: "codex" as const }));
}

function scanClaudeMcpServers(configPath: string, missing: string[]): McpEntry[] {
  if (!existsSync(configPath)) {
    missing.push(configPath);
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(configPath, "utf8"));
  } catch {
    return [];
  }
  const names = new Set<string>();
  const collect = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    for (const name of Object.keys(value as Record<string, unknown>)) {
      names.add(name);
    }
  };
  if (parsed && typeof parsed === "object") {
    collect((parsed as Record<string, unknown>).mcpServers);
    const projects = (parsed as Record<string, unknown>).projects;
    if (projects && typeof projects === "object") {
      for (const project of Object.values(projects as Record<string, unknown>)) {
        if (project && typeof project === "object") {
          collect((project as Record<string, unknown>).mcpServers);
        }
      }
    }
  }
  return [...names].map((name) => ({ name, source: "claude" as const }));
}

function dedupeBy<T>(items: T[], key: (item: T) => string): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const value = key(item);
    if (seen.has(value)) return false;
    seen.add(value);
    return true;
  });
}
