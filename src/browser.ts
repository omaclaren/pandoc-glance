import { spawn } from "node:child_process";

/** Open a URL with the operating system's configured default browser. */
export async function openInDefaultBrowser(url: string): Promise<void> {
  const command = process.platform === "darwin"
    ? { executable: "open", args: [url] }
    : process.platform === "win32"
      ? { executable: "cmd.exe", args: ["/d", "/s", "/c", "start", "", url] }
      : { executable: "xdg-open", args: [url] };

  await new Promise<void>((resolvePromise, rejectPromise) => {
    const child = spawn(command.executable, command.args, {
      stdio: "ignore",
      detached: true,
      windowsHide: true,
    });
    child.once("error", (error) => {
      rejectPromise(
        new Error(
          `Could not open the default browser with ${command.executable}: ${error.message}. `
            + "Retry with --no-open and open the printed URL or HTML path manually.",
          { cause: error },
        ),
      );
    });
    child.once("spawn", () => {
      child.unref();
      resolvePromise();
    });
  });
}
