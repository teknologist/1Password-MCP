/**
 * Shared helpers for parsing and validating `op://vault/item/[section/]field` secret
 * references, used by `op_run`, `op_check_ref`, `item_get`, and `password_read`.
 *
 * `assertVaultAllowed` is only a textual pre-check on the vault segment as
 * written in a reference. The vault a reference actually resolves to is checked
 * by ID with the helpers in `vault-access.ts`.
 */

import { getConfig } from "./config.js";

export interface ParsedSecretRef {
  /** Raw reference string, e.g. "op://Private/github/token". */
  raw: string;
  /** Vault segment (name or ID) as written in the reference. */
  vault: string;
  /** Item segment (name or ID) as written in the reference. */
  item: string;
  /** Optional section segment (name or ID) as written in the reference. */
  section?: string;
  /** Field segment (name or ID) as written in the reference. */
  field: string;
}

const OP_REF_PATTERN = /^op:\/\/([^/]+)\/([^/]+)\/(?:([^/]+)\/)?([^/]+)$/;

/** True if the given string looks like an `op://` secret reference. */
export function isSecretRef(value: string): boolean {
  return OP_REF_PATTERN.test(value);
}

/** Parse three or four literal segments; do not decode or interpret query text. */
export function parseSecretRef(raw: string): ParsedSecretRef {
  const match = OP_REF_PATTERN.exec(raw);
  if (!match) {
    throw new Error(
      `Invalid secret reference '${raw}'. Expected format: op://vault/item/field or op://vault/item/section/field`,
    );
  }
  const [, vault, item, section, field] = match;
  return { raw, vault, item, ...(section === undefined ? {} : { section }), field };
}

/**
 * Throw if the reference's vault segment is not in the server's configured
 * vault allow-list. An empty allow-list (the default) permits any vault.
 * Comparison is case-insensitive against vault names/IDs.
 */
export function assertVaultAllowed(vault: string): void {
  const { allowedVaults } = getConfig();
  if (allowedVaults.length === 0) return; // no restriction configured
  const normalized = vault.toLowerCase();
  const allowed = allowedVaults.some((entry) => entry.toLowerCase() === normalized);
  if (!allowed) {
    throw new Error(
      `Vault '${vault}' is not in the allowed vault list (${allowedVaults.join(", ")}). ` +
        "Configure OP_MCP_ALLOWED_VAULTS or --allowed-vaults to permit it.",
    );
  }
}
