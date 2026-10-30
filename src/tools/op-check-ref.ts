/**
 * op_check_ref — Validate an op://vault/item/field secret reference and
 * return metadata about it (vault, item, field label/type) WITHOUT ever
 * returning the secret value. Use this to sanity-check a reference before
 * passing it to op_run.
 */
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { getClient } from "../client.js";
import { log, logError } from "../logger.js";
import { jsonResult, errorResult } from "../utils.js";
import { parseSecretRef, assertVaultAllowed } from "../secret-ref.js";
import { assertVaultIdAllowed } from "../vault-access.js";
import { selectFieldIndex } from "../field-selection.js";

export function registerOpCheckRef(server: McpServer): void {
  server.registerTool("op_check_ref", { description: "Validate an op://vault/item/field or op://vault/item/section/field secret reference and return only non-secret metadata (vault name, item title, field label, field type) confirming it resolves — the field VALUE is never returned. Use this to check a reference is correct before using it with op_run; do not use password_read/item_get with reveal just to check a reference exists.", inputSchema: z.object({
              secretReference: z
                .string()
                .min(1)
                .describe("Secret reference to validate: op://vault/item/field or op://vault/item/section/field."),
            }) }, async ({ secretReference }) => {
              try {
                log("debug", "Tool call: op_check_ref.", { secretReference: true });

                const ref = parseSecretRef(secretReference);
                assertVaultAllowed(ref.vault);

                const client = await getClient();
                if (!client?.secrets?.resolveAll || !client?.items?.get) {
                  throw new Error(
                    "Your @1password/sdk version does not support resolving secret references.",
                  );
                }

                const resolved = await client.secrets.resolveAll([secretReference]);
                const response = resolved.individualResponses[secretReference];
                if (!response?.content) {
                  const reason = response?.error?.type ?? "unknown";
                  throw new Error(
                    `Could not resolve secret reference '${secretReference}' (${reason}).`,
                  );
                }

                const { vaultId, itemId } = response.content;
                // The vault segment passed the textual pre-check above; also
                // verify the vault the reference actually resolved to.
                await assertVaultIdAllowed(client, vaultId);
                const item = await client.items.get(vaultId, itemId);

                let fields = item.fields ?? [];
                if (ref.section !== undefined) {
                  const section = ref.section;
                  const sections = item.sections ?? [];
                  const ids = [...new Set([...sections.map((entry) => entry.id), ...fields.map((entry) => entry.sectionId)].filter((id): id is string => !!id))];
                  const exact = ids.filter((id) => id === section);
                  const insensitive = ids.filter((id) => id.toLowerCase() === section.toLowerCase());
                  const titles = sections.filter((entry) => entry.title?.toLowerCase() === section.toLowerCase()).map((entry) => entry.id);
                  const matches = exact.length ? exact : insensitive.length ? insensitive : titles;
                  if (matches.length !== 1) {
                    throw new Error("Section not found or ambiguous on the resolved item.");
                  }
                  fields = fields.filter((entry) => entry.sectionId === matches[0]);
                }
                const index = selectFieldIndex(fields, ref.field, true);
                const match = fields[index];

                if (!match) {
                  throw new Error(
                    `Field '${ref.field}' not found on item '${item.title}'.`,
                  );
                }

                // Deliberately omit match.value — this tool never returns secret plaintext.
                return jsonResult({
                  resolved: true,
                  vault: { id: vaultId, name: ref.vault },
                  item: { id: item.id, title: item.title, category: item.category },
                  field: {
                    id: match.id,
                    title: match.title,
                    type: match.fieldType ?? ("type" in match ? match.type : undefined),
                    section: match.sectionId,
                  },
                });
              } catch (error) {
                logError("op_check_ref failed.", error);
                return errorResult(error);
              }
            });
}
