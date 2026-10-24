import { readFileSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

const MAX_FILE_BYTES = 20_000;
const MAX_TOTAL_BYTES = 60_000;
const MAX_FILES = 8;
const IGNORED_SEGMENTS = new Set([
  ".git",
  ".agentspace",
  "node_modules",
  "dist",
  "dist-electron-out",
  "dist-electron-local-out",
]);

export function extractFileReferences(prompt: string): string[] {
  const refs = new Set<string>();
  const pattern = /(?:^|[\s(（\[【])@(?:"([^"]+)"|([^\s@,，。;；:：)）\]】]+))/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(prompt)) !== null) {
    const raw = (match[1] ?? match[2] ?? "").replace(/[.!?！？]+$/, "").replace(/^\.\//, "");
    if (raw) refs.add(raw);
  }
  return [...refs];
}

function isInside(workspace: string, target: string): boolean {
  const rel = relative(workspace, target);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return false;
  return !rel.split(/[\\/]/).some((segment) => IGNORED_SEGMENTS.has(segment));
}

export function buildFileReferenceAppendix(
  workspace: string | undefined,
  prompt: string,
  options: { maxFileBytes?: number; maxTotalBytes?: number } = {},
): string | undefined {
  if (!workspace) return undefined;
  const maxFileBytes = options.maxFileBytes ?? MAX_FILE_BYTES;
  const maxTotalBytes = options.maxTotalBytes ?? MAX_TOTAL_BYTES;
  const blocks: string[] = [];
  let totalBytes = 0;
  for (const ref of extractFileReferences(prompt).slice(0, MAX_FILES)) {
    if (totalBytes >= maxTotalBytes) break;
    const target = resolve(workspace, ref);
    if (!isInside(workspace, target)) continue;
    let size: number;
    try {
      const info = statSync(target);
      if (!info.isFile()) continue;
      size = info.size;
    } catch {
      continue;
    }
    let buffer: Buffer;
    try {
      buffer = readFileSync(target);
    } catch {
      continue;
    }
    if (buffer.includes(0)) continue;
    const budget = Math.min(maxFileBytes, maxTotalBytes - totalBytes);
    const truncated = buffer.length > budget;
    const text = buffer.subarray(0, budget).toString("utf8");
    totalBytes += Math.min(buffer.length, budget);
    const displayPath = relative(workspace, target).split(sep).join("/");
    blocks.push(
      `### ${displayPath}${size > budget ? `（已截断，原文件 ${size} 字节）` : ""}\n\`\`\`\n${text}${truncated ? "\n…（以下省略）" : ""}\n\`\`\``,
    );
  }
  if (blocks.length === 0) return undefined;
  return [
    "## 引用文件（用户用 @ 指定，以下内容已附上；这些文件仍可能需要你自行核对）",
    ...blocks,
  ].join("\n\n");
}
