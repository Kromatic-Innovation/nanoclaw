import { execFile } from "node:child_process";

/**
 * Run a JXA (JavaScript for Automation) script via osascript and return parsed JSON.
 * All Apple Reminders interactions go through this function.
 */
export function runJxa<T>(script: string): Promise<T> {
  return new Promise((resolve, reject) => {
    execFile(
      "osascript",
      ["-l", "JavaScript", "-e", script],
      { maxBuffer: 10 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`JXA error: ${stderr || error.message}`));
          return;
        }
        try {
          resolve(JSON.parse(stdout.trim()) as T);
        } catch {
          reject(
            new Error(`Failed to parse JXA output: ${stdout.slice(0, 500)}`)
          );
        }
      }
    );
  });
}
