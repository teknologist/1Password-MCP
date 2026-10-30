/**
 * item_edit — Edit an existing 1Password item: title, notes, tags, url, and fields.
 *
 * The item is fetched, changes are applied immutably, and the result is written
 * back via items.put. Unreferenced fields are preserved untouched. Field values
 * are never logged.
 */
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import {
  ItemFieldType,
  AutofillBehavior,
  type Item,
  type ItemField,
  type Website,
} from "@1password/sdk";
import { getClient } from "../client.js";
import { log, logError } from "../logger.js";
import { jsonResult, errorResult } from "../utils.js";
import { assertVaultIdAllowed } from "../vault-access.js";
import { selectFieldIndex } from "../field-selection.js";

/** A field upsert request from the caller. */
const fieldInput = z.object({
  idOrTitle: z
    .string()
    .min(1)
    .describe("Select an exact ID, then a unique case-insensitive ID or title. Ambiguous matches fail; absent targets are created."),
  type: z
    .enum(["text", "concealed"])
    .describe("Field type: 'text' for plain values, 'concealed' for secrets."),
  value: z.string().describe("New value for the field."),
  section: z
    .string()
    .optional()
    .describe("Optional section id to associate the field with."),
});

export function registerItemEdit(server: McpServer): void {
  server.registerTool("item_edit", { description: "Edit an existing 1Password item. Update the title, notes (pass an empty string to clear notes), tags, website URL, upsert fields, or remove fields. Only referenced fields are changed; all others are preserved.", inputSchema: z.object({
              vaultId: z.string().min(1).describe("Vault ID containing the item."),
              itemId: z.string().min(1).describe("Item ID to edit."),
              title: z.string().min(1).optional().describe("New item title."),
              notes: z
                .string()
                .optional()
                .describe(
                  "Full replacement of the item's notes. Pass an empty string to clear notes.",
                ),
              tags: z
                .array(z.string().min(1))
                .optional()
                .describe("Replacement set of tags (replaces all existing tags)."),
              url: z
                .string()
                .url()
                .optional()
                .describe("Replacement URL for the first website; preserves its metadata and all other websites."),
              fields: z
                .array(fieldInput)
                .optional()
                .describe("Fields to upsert (create or update) by id or title."),
              removeFields: z
                .array(z.string().min(1))
                .optional()
                .describe("Field IDs or unique titles to remove. IDs take priority; ambiguous matches fail before a write."),
            }) }, async ({ vaultId, itemId, title, notes, tags, url, fields, removeFields }) => {
              try {
                // NOTE: field values are intentionally excluded from logs.
                log("debug", "Tool call: item_edit.", {
                  vaultId,
                  itemId,
                  changeTitle: title !== undefined,
                  changeNotes: notes !== undefined,
                  changeTags: tags !== undefined,
                  changeUrl: url !== undefined,
                  upsertCount: fields?.length ?? 0,
                  removeCount: removeFields?.length ?? 0,
                });

                const client = await getClient();
                try {
                  await assertVaultIdAllowed(client, vaultId);
                } catch {
                  const safeError = new Error(`Vault '${vaultId}' is not in the allowed vault list, or vault access verification failed.`);
                  logError("item_edit failed.", safeError);
                  return errorResult(safeError);
                }
                if (!client?.items?.get) {
                  return errorResult(new Error("Your @1password/sdk version does not support getting items."));
                }
                if (!client?.items?.put) {
                  return errorResult(new Error("Your @1password/sdk version does not support updating items."));
                }

                const existing: Item = await client.items.get(vaultId, itemId);

                const originalFields = existing.fields ?? [];
                let removeSet: Set<number>;
                let upserts: { upsert: z.infer<typeof fieldInput>; index: number }[];
                try {
                  removeSet = new Set((removeFields ?? []).map((target) => selectFieldIndex(originalFields, target)));
                  upserts = (fields ?? []).map((upsert) => ({ upsert, index: selectFieldIndex(originalFields, upsert.idOrTitle) }));
                  const targets = new Set<string>();
                  for (const { upsert, index } of upserts) {
                    const key = index >= 0 ? `index:${index}` : `new:${upsert.idOrTitle.toLowerCase()}`;
                    if (targets.has(key) || (index >= 0 && removeSet.has(index))) {
                      throw new Error("Conflicting field operations. Select each field only once.");
                    }
                    targets.add(key);
                  }
                } catch (error) {
                  return errorResult(error);
                }
                let nextFields: ItemField[] = [...originalFields];
                for (const { upsert, index } of upserts) {
                  const fieldType =
                    upsert.type === "concealed"
                      ? ItemFieldType.Concealed
                      : ItemFieldType.Text;
                  if (index >= 0) {
                    const current = nextFields[index];
                    const replacement: ItemField = {
                      ...current,
                      fieldType,
                      value: upsert.value,
                      sectionId: upsert.section ?? current.sectionId,
                    };
                    nextFields = nextFields.map((field, i) =>
                      i === index ? replacement : field,
                    );
                  } else {
                    nextFields = [
                      ...nextFields,
                      {
                        id: upsert.idOrTitle,
                        title: upsert.idOrTitle,
                        fieldType,
                        value: upsert.value,
                        sectionId: upsert.section,
                      },
                    ];
                  }
                }

                nextFields = nextFields.filter((_, index) => !removeSet.has(index));
                let nextWebsites: Website[] | undefined = existing.websites;
                if (url !== undefined) {
                  const [first, ...rest] = existing.websites ?? [];
                  nextWebsites = first
                    ? [{ ...first, url }, ...rest]
                    : [{ url, label: "website", autofillBehavior: AutofillBehavior.AnywhereOnWebsite }];
                }

                const updated: Item = {
                  ...existing,
                  title: title ?? existing.title,
                  notes: notes ?? existing.notes,
                  tags: tags ?? existing.tags,
                  websites: nextWebsites,
                  fields: nextFields,
                };

                const result: Item = await client.items.put(updated);

                return jsonResult({
                  id: result.id,
                  title: result.title,
                  vaultId: result.vaultId,
                  category: result.category,
                  tags: result.tags ?? [],
                  fieldCount: result.fields?.length ?? 0,
                  updatedAt: result.updatedAt,
                });
              } catch {
                const safeError = new Error("Item edit failed. Check item metadata before retrying; the write outcome may be unknown.");
                logError("item_edit failed.", safeError);
                return errorResult(safeError);
              }
            });
}
