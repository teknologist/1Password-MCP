/**
 * item_lookup — Search for items in a 1Password vault.
 */
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { getClient } from "../client.js";
import { log, logError } from "../logger.js";
import { jsonResult, errorResult } from "../utils.js";
import { assertVaultIdAllowed } from "../vault-access.js";
import type { ItemSummary } from "../types.js";
import type { ItemOverview } from "@1password/sdk";
import { pageOptions, pageOffset, localPage } from "../item-pagination.js";

export function registerItemLookup(server: McpServer): void {
  server.registerTool("item_lookup", { description: "Search item metadata by title substring and exact tag. Optional local pages use stable title/ID order and bound response size, not SDK fetch cost. Vault changes can skip or repeat items. Without page inputs, preserves legacy order and limit behavior.", inputSchema: z.object({
              vaultId: z.string().min(1).describe("Vault ID to search within."),
              query: z
                .string()
                .optional()
                .describe("Optional substring to filter item titles (case-insensitive)."),
              ...pageOptions,
              limit: z
                .number()
                .int()
                .positive()
                .max(200)
                .optional()
                .describe("Maximum number of items to return (default: all)."),
            }) }, async ({ vaultId, query, limit, tag, pageSize, cursor }) => {
              try {
                log("debug", "Tool call: item_lookup.", {
                  vaultId,
                  hasQuery: Boolean(query),
                  limit,
                });
                const normalizedQuery = query?.toLowerCase() ?? "";
                const position = pageOffset(cursor, ["item_lookup", vaultId, normalizedQuery, tag ?? null, limit ?? null]);
                const client = await getClient();
                await assertVaultIdAllowed(client, vaultId);
                let items: ItemOverview[];
                if (client?.items?.list) {
                  items = await client.items.list(vaultId);
                } else if (client?.items && "listAll" in client.items && typeof client.items.listAll === "function") {
                  items = await client.items.listAll(vaultId);
                } else {
                  throw new Error("Your @1password/sdk version does not support listing items.");
                }
                const filtered = normalizedQuery
                  ? (items ?? []).filter((item) =>
                      item.title?.toLowerCase().includes(normalizedQuery),
                    )
                  : items ?? [];
                const page = localPage(filtered, { tag, pageSize, cursor }, position, limit);
                const summary: ItemSummary[] = page.items.map((item) => ({
                  id: item.id,
                  title: item.title,
                  category: item.category,
                  vaultId: item.vaultId ?? vaultId,
                }));
                return jsonResult({ items: summary, count: summary.length, ...(page.nextCursor !== undefined ? { nextCursor: page.nextCursor } : {}) });
              } catch (error) {
                logError("item_lookup failed.", error);
                return errorResult(error);
              }
            });
}
