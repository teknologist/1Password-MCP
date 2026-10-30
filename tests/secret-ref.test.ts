/**
 * Tests for src/secret-ref.ts — op:// reference parsing and vault allow-listing.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resetConfig } from "../src/config.js";
import {
  isSecretRef,
  parseSecretRef,
  assertVaultAllowed,
} from "../src/secret-ref.js";

describe("secret-ref", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    resetConfig();
    delete process.env.OP_MCP_ALLOWED_VAULTS;
  });

  afterEach(() => {
    Object.keys(process.env).forEach((key) => {
      if (!(key in originalEnv)) delete process.env[key];
      else process.env[key] = originalEnv[key];
    });
    resetConfig();
  });

  describe("isSecretRef", () => {
    it("recognizes a well-formed op:// reference", () => {
      expect(isSecretRef("op://Private/github/token")).toBe(true);
    });

    it("rejects plain literal strings", () => {
      expect(isSecretRef("plain-value")).toBe(false);
      expect(isSecretRef("https://example.com")).toBe(false);
    });
  });

  describe("parseSecretRef", () => {
    it("splits vault/item/field segments", () => {
      const ref = parseSecretRef("op://Private/github/token");
      expect(ref.vault).toBe("Private");
      expect(ref.item).toBe("github");
      expect(ref.field).toBe("token");
    });

    it("repair: parses an optional section separately from the field", () => {
      expect(parseSecretRef("op://Private/github/section/nested-field")).toEqual({ raw: "op://Private/github/section/nested-field", vault: "Private", item: "github", section: "section", field: "nested-field" });
      expect(parseSecretRef("op://Private/github/token").section).toBeUndefined();
    });

    it.each(["op://v/i/s/f/extra", "op:///i/f", "op://v//f", "op://v/i/", "op://v/i//f", "op://v/i/s/"])("repair: rejects malformed segment counts and empty segments (%s)", (raw) => {
      expect(() => parseSecretRef(raw)).toThrow(/Invalid secret reference/);
      expect(isSecretRef(raw)).toBe(false);
    });

    it("repair: preserves literal encoded segments and query text without URL decoding", () => {
      expect(parseSecretRef("op://Private%20Vault/item%2Fname/section%20name/token%2Fid?attribute=password")).toEqual({
        raw: "op://Private%20Vault/item%2Fname/section%20name/token%2Fid?attribute=password",
        vault: "Private%20Vault", item: "item%2Fname", section: "section%20name", field: "token%2Fid?attribute=password",
      });
      expect(parseSecretRef("op://Private/item/token?attribute=password").field).toBe("token?attribute=password");
    });

    it("throws on a malformed reference", () => {
      expect(() => parseSecretRef("not-a-ref")).toThrow(/Invalid secret reference/);
      expect(() => parseSecretRef("op://only-vault")).toThrow(/Invalid secret reference/);
    });
  });

  describe("assertVaultAllowed", () => {
    it("allows any vault when no allow-list is configured (default)", () => {
      expect(() => assertVaultAllowed("Private")).not.toThrow();
      expect(() => assertVaultAllowed("anything-else")).not.toThrow();
    });

    it("restricts to the configured vaults when OP_MCP_ALLOWED_VAULTS is set", () => {
      process.env.OP_MCP_ALLOWED_VAULTS = "personal, work";
      resetConfig();
      expect(() => assertVaultAllowed("personal")).not.toThrow();
      expect(() => assertVaultAllowed("work")).not.toThrow();
      expect(() => assertVaultAllowed("WORK")).not.toThrow(); // case-insensitive
      expect(() => assertVaultAllowed("Private")).toThrow(/not in the allowed vault list/);
    });
  });
});
