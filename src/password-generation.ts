import { z } from "zod";
import type { Item, ItemField } from "@1password/sdk";
import { buildCharset, generatePassword, generateMemorablePassword, getAllWords } from "./utils.js";

export const memorableOptions = z.object({
  wordCount: z.number().int().min(2).max(10).optional().describe("Number of words. Defaults to 7."),
  separator: z.string().max(5).optional().describe("Word separator. Defaults to '-'."),
  includeNumber: z.boolean().optional().describe("Append a random number (0-99). Defaults to true."),
  includeSymbol: z.boolean().optional().describe("Append a random symbol. Defaults to true."),
  capitalize: z.boolean().optional().describe("Capitalize each word. Defaults to true; adds no entropy."),
});

export const randomOptions = z.object({
  length: z.number().int().min(8).max(128).optional().describe("Password length. Defaults to 20."),
  includeSymbols: z.boolean().optional().describe("Include symbols. Defaults to true."),
  includeNumbers: z.boolean().optional().describe("Include digits. Defaults to true."),
  includeUppercase: z.boolean().optional().describe("Include uppercase letters. Defaults to true."),
});

export const generationOptions = z.discriminatedUnion("style", [
  z.object({ style: z.literal("random"), ...randomOptions.shape }),
  z.object({ style: z.literal("memorable"), ...memorableOptions.shape }),
]);

export function randomPassword(options: z.infer<typeof randomOptions>): string {
  return generatePassword(options.length ?? 20, buildCharset({
    includeSymbols: options.includeSymbols ?? true,
    includeNumbers: options.includeNumbers ?? true,
    includeUppercase: options.includeUppercase ?? true,
  }));
}

export function storedPassword(value: string | undefined, generate: z.infer<typeof generationOptions> | undefined): string {
  if ((value === undefined) === (generate === undefined)) {
    throw new Error("Supply exactly one explicit password value or generate options.");
  }
  if (value !== undefined) return value;
  if (generate?.style === "random") return randomPassword(generate);
  if (generate?.style === "memorable") return memorablePasswordResult(generate).password;
  throw new Error("Missing generation options.");
}

export const PASSWORD_REFERENCE_WARNING = "Password saved, but no reliable secret reference is available from the SDK response. Do not retry the write; inspect item metadata.";

export function passwordReference(item: Item, field: Pick<ItemField, "id" | "sectionId"> | undefined): string | undefined {
  if (!field || !Array.isArray(item.fields)) return undefined;
  const matches = item.fields.filter((candidate) => candidate?.id === field.id
    && (candidate.sectionId || undefined) === (field.sectionId || undefined));
  if (matches.length !== 1) return undefined;
  const segments = [item.vaultId, item.id, ...(field.sectionId ? [field.sectionId] : []), field.id];
  if (segments.some((value) => typeof value !== "string" || !value || value.includes("/"))) return undefined;
  return `op://${segments.join("/")}`;
}

export function passwordError(operation: "create" | "update"): Error {
  return new Error(`Password ${operation === "create" ? "creation" : "update"} failed. Check item metadata before retrying; the write outcome may be unknown.`);
}

export function memorablePasswordResult(options: z.infer<typeof memorableOptions>) {
  const resolved = {
    wordCount: options.wordCount ?? 7,
    separator: options.separator ?? "-",
    includeNumber: options.includeNumber ?? true,
    includeSymbol: options.includeSymbol ?? true,
    capitalize: options.capitalize ?? true,
  };
  const password = generateMemorablePassword(resolved);
  const dictionarySize = getAllWords().length;
  const bits = resolved.wordCount * Math.log2(dictionarySize)
    + (resolved.includeNumber ? Math.log2(100) : 0)
    + (resolved.includeSymbol ? Math.log2(8) : 0);
  const estimate = Math.round(bits * 100) / 100;
  return /[^a-z]/i.test(resolved.separator)
    ? { password, dictionarySize, entropyBits: estimate }
    : { password, dictionarySize, samplingEntropyBits: estimate, entropyNote: "Sampling entropy is an upper bound on output entropy because word boundaries can be ambiguous." };
}
