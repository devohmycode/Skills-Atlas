import { spawn } from 'node:child_process';

/** Open a URL without invoking a shell. Missing desktop browsers are harmless. */
export function openBrowser(url: string): void {
  const [file, args] = process.platform === 'win32'
    ? ['rundll32', ['url.dll,FileProtocolHandler', url]] as const
    : process.platform === 'darwin' ? ['open', [url]] as const : ['xdg-open', [url]] as const;
  try {
    const child = spawn(file, [...args], { stdio: 'ignore', detached: true, windowsHide: true });
    child.on('error', () => {});
    child.unref();
  } catch { /* Keep browsing the catalog when no browser is available. */ }
}
