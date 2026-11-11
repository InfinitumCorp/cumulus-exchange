import { createServerFn } from "@tanstack/react-start";
import { authMiddleware } from "@/lib/auth/middleware";

/**
 * @search in Cumulus Exchange: type "@search <question>" in the catalog search box.
 * Infinitum Search reads the web and the answer box shows a short answer with numbered sources.
 * Off until a search engine (SEARXNG_URL, YANDEX_SEARCH_API_KEY + YANDEX_FOLDER_ID, or
 * BRAVE_SEARCH_API_KEY) is set on the server.
 */
export const askSearch = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: unknown) => {
    const value = input as { text?: string; context?: string };
    const text = String(value?.text ?? "").slice(0, 8000);
    if (!text.trim()) throw new Error("Write @search and a question.");
    return { text, context: String(value?.context ?? "").slice(0, 8000) };
  })
  .handler(async ({ data, context }) => {
    const { searchFor } = await import("./search-core");
    return searchFor(process.env, { text: data.text, context: data.context, user: context.userId });
  });
