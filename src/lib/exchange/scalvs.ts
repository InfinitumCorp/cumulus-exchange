import { createServerFn } from "@tanstack/react-start";
import { authMiddleware } from "@/lib/auth/middleware";

/**
 * @scalvs / @scalus in Cumulus://Cloud: type "@scalvs <task>" in the catalog search and press Enter.
 * The SCALVS agent (on an OpenClaw gateway) answers over the datasets in view.
 * Off until OPENCLAW_GATEWAY_URL and OPENCLAW_GATEWAY_TOKEN are set on the server
 * (the token never reaches the browser).
 */
export const askScalvs = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: unknown) => {
    const value = input as { text?: string; context?: string };
    const text = String(value?.text ?? "").slice(0, 8000);
    if (!text.trim()) throw new Error("Write @scalvs and a task.");
    return { text, context: String(value?.context ?? "").slice(0, 20000) };
  })
  .handler(async ({ data, context }) => {
    const { askScalvsFor } = await import("./scalvs-core");
    return askScalvsFor(process.env, { text: data.text, context: data.context, user: context.userId });
  });
