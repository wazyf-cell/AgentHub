import { spawn } from "node:child_process";
import { buildWindowsShellCommandLine } from "../../process-launch.ts";

export async function runVersionCommand(executable: string, args: string[]): Promise<string> {
  return await new Promise<string>((resolve) => {
    const shellCommandLine = buildWindowsShellCommandLine(executable, args);
    const child = shellCommandLine
      ? spawn(shellCommandLine, {
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
        shell: true,
      })
      : spawn(executable, args, {
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      });
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      output += String(chunk);
    });
    child.on("error", () => {
      resolve("");
    });
    child.on("close", (exitCode) => {
      resolve(exitCode === 0 ? output.trim().split(/\r?\n/)[0] ?? "" : "");
    });
  });
}
