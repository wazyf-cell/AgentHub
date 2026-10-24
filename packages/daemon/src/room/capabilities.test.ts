import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { scanCapabilities } from "./capabilities.ts";

test("capabilities scan reads skill names and MCP server names without secrets", () => {
  const home = mkdtempSync(join(tmpdir(), "agenthub-capabilities-"));
  try {
    const claudeSkill = join(home, ".claude", "skills", "reviewer");
    mkdirSync(claudeSkill, { recursive: true });
    writeFileSync(join(claudeSkill, "SKILL.md"), "---\nname: Reviewer\ndescription: Review code\n---\n# Reviewer\n");

    const librarySkill = join(home, ".skill-library", "skills", "frontend", "css-audit");
    mkdirSync(librarySkill, { recursive: true });
    writeFileSync(join(librarySkill, "SKILL.md"), "---\nname: CSS Audit\ndescription: Audit CSS\n---\n");

    mkdirSync(join(home, ".codex"), { recursive: true });
    writeFileSync(join(home, ".codex", "config.toml"), [
      "[mcp_servers.memory]",
      'command = "npx"',
      'env = { API_KEY = "sk-should-not-appear" }',
      "[mcp_servers.memory.env]",
      'TOKEN = "sk-should-not-appear"',
      "[mcp_servers.context7]",
      'command = "npx"',
    ].join("\n"));

    writeFileSync(join(home, ".claude.json"), JSON.stringify({
      mcpServers: { obsidian: { command: "node", env: { SECRET: "sk-should-not-appear" } } },
      projects: {},
    }));

    const manifest = scanCapabilities({ home });
    assert.deepEqual(
      manifest.skills.map((skill) => skill.name).sort(),
      ["CSS Audit", "Reviewer"],
    );
    assert.ok(manifest.skills.some((skill) => skill.category === "frontend"));
    assert.deepEqual(
      manifest.mcpServers.map((server) => server.name).sort(),
      ["context7", "memory", "obsidian"],
    );
    assert.ok(!JSON.stringify(manifest).includes("sk-should-not-appear"));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
