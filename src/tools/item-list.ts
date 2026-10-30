/**
 * item_list — List all items in a 1Password vault (metadata only, no secrets).
 */
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { ItemOverview } from "@1password/sdk";
import { getClient } from "../client.js";
import { log, logError } from "../logger.js";
import { jsonResult, errorResult } from "../utils.js";
import { assertVaultIdAllowed } from "../vault-access.js";
import { pageOptions, pageOffset, localPage } from "../item-pagination.js";

export function registerItemList(server: McpServer): void {
  server.registerTool("item_list", { description: "List item metadata without secret values. Supports exact tag filtering and local pages in title/ID order. Pages bound response size, not SDK fetch cost; vault changes can skip or repeat items. Without page inputs, preserves the legacy response and order.", inputSchema: z.object({
              vaultId: z.string().min(1).describe("Vault ID to list items from."),
              ...pageOptions,
            }) }, async ({ vaultId, tag, pageSize, cursor }) => {
              try {
                log("debug", "Tool call: item_list.", { vaultId });
                const position = pageOffset(cursor, ["item_list", vaultId, tag ?? null]);
                const client = await getClient();
                await assertVaultIdAllowed(client, vaultId);
                if (!client?.items?.list) {
                  throw new Error(
                    "Your @1password/sdk version does not support listing items.",
                  );
                }

                const items: ItemOverview[] = await client.items.list(vaultId);
                const page = localPage(items ?? [], { tag, pageSize, cursor }, position);
                const summary = page.items.map((item) => ({
                  id: item.id,
                  title: item.title,
                  category: item.category,
                  tags: item.tags ?? [],
                  updatedAt: item.updatedAt,
                }));

                return jsonResult({ items: summary, count: summary.length, ...(page.nextCursor !== undefined ? { nextCursor: page.nextCursor } : {}) });
              } catch (error) {
                logError("item_list failed.", error);
                return errorResult(error);
              }
            });
}
