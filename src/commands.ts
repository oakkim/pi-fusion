/** The two command groups share routing, help, and full-argument completion. */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export type Subcommand = Parameters<ExtensionAPI["registerCommand"]>[1] & { acceptsArguments?: boolean };

export function registerCommandGroup(pi: ExtensionAPI, name: string, commands: ReadonlyMap<string, Subcommand>): void {
  const help = () => [`/${name} [subcommand] (default: status)`, ...[...commands].map(([key, command]) => `  ${key}: ${command.description ?? ""}`), "  help: Show this help"].join("\n");
  pi.registerCommand(name, {
    description: `${name === "fusion" ? "Fusion" : "Advisor"} controls. Use /${name} help for subcommands.`,
    getArgumentCompletions: async (prefix) => {
      const input = prefix.trimStart();
      const child = /^(\S+)\s+([\s\S]*)$/.exec(input);
      if (child) {
        const key = child[1]!.toLowerCase();
        const matches = await commands.get(key)?.getArgumentCompletions?.(child[2]!);
        return matches?.length ? matches.map((item) => ({ ...item, value: `${key} ${item.value}` })) : null;
      }
      const matches = [...commands, ["help", { description: "Show this help" }] as const]
        .filter(([key]) => key.startsWith(input.toLowerCase()))
        .map(([key, command]) => ({ value: `${key} `, label: key, description: command.description }));
      return matches.length ? matches : null;
    },
    handler: async (args, ctx) => {
      const match = /^(\S+)(?:\s+([\s\S]*))?$/.exec(args.trim());
      const key = match?.[1]?.toLowerCase() ?? "status";
      const rest = match?.[2] ?? "";
      const command = commands.get(key);
      if (key === "help" || !command || (command.acceptsArguments === false && rest)) {
        const error = key !== "help" || !!rest;
        const text = `${error ? `Unknown command or arguments: /${name} ${args.trim()}\n` : ""}${help()}`;
        if (ctx.mode === "print" || ctx.mode === "json") console.log(text);
        else ctx.ui.notify(text, error ? "error" : "info");
        return;
      }
      await command.handler(rest, ctx);
    },
  });
}
