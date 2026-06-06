// Minimal interactive prompts (no deps). Hidden input for passphrases.
import { createInterface } from "node:readline";

export function ask(question: string, def?: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const q = def ? `${question} (${def}): ` : `${question}: `;
  return new Promise((resolve) => {
    rl.question(q, (answer) => {
      rl.close();
      resolve(answer.trim() || def || "");
    });
  });
}

/** Read a line without echoing it (for passphrases / secrets). */
export function askHidden(question: string): Promise<string> {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    const out = process.stdout;
    out.write(`${question}: `);
    const wasRaw = stdin.isRaw;
    if (stdin.isTTY) stdin.setRawMode(true);
    stdin.resume();
    let buf = "";
    const onData = (chunk: Buffer) => {
      const s = chunk.toString("utf8");
      for (const ch of s) {
        const code = ch.charCodeAt(0);
        if (ch === "\n" || ch === "\r" || code === 4 /* EOT */) {
          if (stdin.isTTY) stdin.setRawMode(wasRaw ?? false);
          stdin.removeListener("data", onData);
          stdin.pause();
          out.write("\n");
          resolve(buf);
          return;
        } else if (code === 3 /* Ctrl-C */) {
          out.write("\n");
          process.exit(130);
        } else if (code === 127 || code === 8 /* backspace */) {
          buf = buf.slice(0, -1);
        } else if (code >= 32) {
          buf += ch;
        }
      }
    };
    stdin.on("data", onData);
  });
}

export async function confirm(question: string, def = false): Promise<boolean> {
  const a = (await ask(`${question} ${def ? "[Y/n]" : "[y/N]"}`)).toLowerCase();
  if (!a) return def;
  return a === "y" || a === "yes";
}
