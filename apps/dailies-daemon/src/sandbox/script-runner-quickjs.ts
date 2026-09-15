import type { BrowserManager } from "../browser-manager.js";
import { QuickJSSandbox } from "./quickjs-sandbox.js";

interface ScriptOutput {
  onCaption?: (event: { at: string; durationMs: number; text: string }) => void;
  onStderr: (data: string) => void;
  onStdout: (data: string) => void;
}

export async function runScript(
  script: string,
  manager: BrowserManager,
  browserName: string,
  output: ScriptOutput,
  options: { timeout?: number; memoryLimitBytes?: number } = {}
): Promise<void> {
  const sandbox = new QuickJSSandbox({
    manager,
    browserName,
    onCaption: output.onCaption,
    onStdout: output.onStdout,
    onStderr: output.onStderr,
    memoryLimitBytes: options.memoryLimitBytes,
    timeoutMs: options.timeout,
  });

  try {
    await sandbox.initialize();
    await sandbox.executeScript(`(async () => {\n${script}\n})()`);
  } finally {
    await sandbox.dispose();
  }
}
