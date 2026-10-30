import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { AutofillBehavior, ItemCategory, ItemFieldType, ItemState, type Item, type ItemOverview } from "@1password/sdk";

vi.mock("../src/client.js", () => ({ getClient: vi.fn() }));
vi.mock("../src/logger.js", () => ({ log: vi.fn(), logError: vi.fn() }));
import { getClient } from "../src/client.js";
import { resetConfig } from "../src/config.js";
import { logError } from "../src/logger.js";
import { buildServer } from "../src/server.js";

function fixture(): Item {
  return {
    id: "item-id", vaultId: "vault-id", title: "Test login", category: ItemCategory.Login,
    version: 7, notes: "Keep notes", tags: ["test"], sections: [], files: [],
    fields: [{ id: "password", title: "Password", fieldType: ItemFieldType.Concealed, value: "old-test-value" }],
    websites: [], createdAt: new Date("2026-01-01"), updatedAt: new Date("2026-01-02"),
  } satisfies Item;
}

describe("Safe tools through MCP with a fake SDK", () => {
  let client: Client;
  let closeServer: () => Promise<void>;
  let item: Item;
  let overviews: ItemOverview[];
  let list: ReturnType<typeof vi.fn<(vaultId: string) => Promise<ItemOverview[]>>>;
  let get: ReturnType<typeof vi.fn<(vaultId: string, itemId: string) => Promise<Item>>>;
  let put: ReturnType<typeof vi.fn<(value: Item) => Promise<Item>>>;
  type CreateInput = Parameters<Awaited<ReturnType<typeof getClient>>["items"]["create"]>[0];
  let create: ReturnType<typeof vi.fn<(value: CreateInput) => Promise<Item>>>;
  let resolveAll: ReturnType<typeof vi.fn>;
  const originalEnv = { ...process.env };

  beforeEach(async () => {
    vi.clearAllMocks();
    delete process.env.OP_MCP_ALLOWED_VAULTS;
    resetConfig();
    item = fixture();
    put = vi.fn(async (value: Item) => value);
    create = vi.fn(async (value: CreateInput) => ({ ...fixture(), ...value, fields: value.fields ?? [], files: [], document: undefined, id: "created-item-id" }));
    overviews = [
      { ...fixture(), id: "z", title: "Beta", state: ItemState.Active, tags: ["team"] } satisfies ItemOverview,
      { ...fixture(), id: "b", title: "Alpha", state: ItemState.Active, tags: ["team", "prod"] } satisfies ItemOverview,
      { ...fixture(), id: "a", title: "Alpha", state: ItemState.Active, tags: [] } satisfies ItemOverview,
    ];
    list = vi.fn(async (_vaultId: string) => overviews);
    get = vi.fn(async (_vaultId: string, _itemId: string) => item);
    resolveAll = vi.fn(async (refs: string[]) => ({ individualResponses: Object.fromEntries(refs.map((ref) => [ref, { content: { vaultId: "vault-id", itemId: ref.split("/")[3], secret: "synthetic-resolved-value" } }])) }));
    const fake = { items: { get, put, create, list }, secrets: { resolveAll } };
    vi.mocked(getClient).mockResolvedValue(fake as unknown as Awaited<ReturnType<typeof getClient>>);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const handle = serveStdio(() => buildServer(), { transport: serverTransport });
    closeServer = () => handle.close();
    client = new Client({ name: "safe-tools-test", version: "0.0.0" });
    await client.connect(clientTransport);
  });

  afterEach(async () => {
    await client.close();
    await closeServer();
    process.env = { ...originalEnv };
    resetConfig();
  });

  async function call(name: string, args: Record<string, unknown> = {}) {
    return client.callTool({ name, arguments: { vaultId: "vault-id", itemId: "item-id", ...args } });
  }

  it.each([AutofillBehavior.Never, AutofillBehavior.ExactDomain, AutofillBehavior.AnywhereOnWebsite])("preserves first website metadata and secondary order (%s)", async (autofillBehavior) => {
    item.websites = [
      { url: "https://old.example", label: "Custom", autofillBehavior },
      { url: "https://second.example", label: "Secondary", autofillBehavior: AutofillBehavior.Never },
      { url: "https://third.example", label: "Third", autofillBehavior: AutofillBehavior.Never },
    ];
    const before = structuredClone(item);
    const result = await call("item_edit", { url: "https://new.example" });
    expect(result.isError).not.toBe(true);
    expect(put.mock.calls[0][0].websites).toEqual([{ ...before.websites![0], url: "https://new.example" }, ...before.websites!.slice(1)]);
    expect(item).toEqual(before);
  });

  it.each(["item_edit", "password_update"])("%s selects an exact ID before another field's title", async (tool) => {
    item.fields = [
      { id: "other", title: "password", fieldType: ItemFieldType.Text, value: "keep" },
      { id: "password", title: "Actual", fieldType: ItemFieldType.Text, value: "replace", sectionId: "section-id" },
    ];
    const before = structuredClone(item);
    const result = await call(tool, tool === "item_edit"
      ? { fields: [{ idOrTitle: "password", type: "concealed", value: "new-test-value" }] }
      : { newPassword: "new-test-value" });
    expect(result.isError).not.toBe(true);
    const written = put.mock.calls[0][0];
    expect(written.fields[0]).toEqual(before.fields[0]);
    expect(written.fields[1]).toEqual({ ...before.fields[1], fieldType: ItemFieldType.Concealed, value: "new-test-value" });
    expect(written.version).toBe(7);
    expect(item).toEqual(before);
  });

  it.each(["update", "remove", "password"])("rejects ambiguous title %s before any write", async (operation) => {
    item.fields = [
      { id: "one", title: "Duplicate", sectionId: "s1", fieldType: ItemFieldType.Concealed, value: "hidden-one" },
      { id: "two", title: "duplicate", sectionId: "s2", fieldType: ItemFieldType.Concealed, value: "hidden-two" },
    ];
    const args = operation === "remove" ? { removeFields: ["duplicate"] }
      : operation === "update" ? { fields: [{ idOrTitle: "duplicate", type: "text", value: "new" }] }
      : { field: "duplicate", newPassword: "new-test-value" };
    const result = await call(operation === "password" ? "password_update" : "item_edit", args);
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain("Ambiguous field");
    expect(JSON.stringify(result)).toContain("one");
    expect(JSON.stringify(result)).toContain("two");
    expect(JSON.stringify(result)).not.toContain("hidden-");
    expect(put).not.toHaveBeenCalled();
  });

  it.each(["item_edit", "password_update"])("%s preserves case-insensitive ID/title matching and missing-field creation", async (tool) => {
    item.fields = [{ id: "CamelID", title: "Friendly", sectionId: "section-id", fieldType: ItemFieldType.Text, value: "old" }];
    for (const target of ["camelid", "FRIENDLY"]) {
      const result = await call(tool, tool === "item_edit" ? { fields: [{ idOrTitle: target, type: "concealed", value: "test-new" }] } : { field: target, newPassword: "test-new" });
      expect(result.isError).not.toBe(true);
      expect(put.mock.calls.at(-1)![0].fields[0]).toEqual({ ...item.fields[0], fieldType: ItemFieldType.Concealed, value: "test-new" });
    }
    const result = await call(tool, tool === "item_edit" ? { fields: [{ idOrTitle: "NewID", type: "text", value: "new" }] } : { field: "NewID", newPassword: "new" });
    expect(result.isError).not.toBe(true);
    expect(put.mock.calls.at(-1)![0].fields[1].id).toBe(tool === "item_edit" ? "NewID" : "newid");
  });

  it("selects one exact removal ID rather than deleting a colliding title", async () => {
    item.fields = [
      { id: "other", title: "password", fieldType: ItemFieldType.Text, value: "keep" },
      { id: "password", title: "Actual", fieldType: ItemFieldType.Text, value: "remove" },
    ];
    const result = await call("item_edit", { removeFields: ["password"] });
    expect(result.isError).not.toBe(true);
    expect(put.mock.calls[0][0].fields).toEqual([item.fields[0]]);
  });

  it("resolves title edits against original data before changing field sections", async () => {
    item.fields = [{ id: "field-id", title: "Shared", sectionId: "original-section", fieldType: ItemFieldType.Text, value: "old" }];
    const result = await call("item_edit", { fields: [{ idOrTitle: "Shared", type: "text", value: "new", section: "new-section" }] });
    expect(result.isError).not.toBe(true);
    expect(put.mock.calls[0][0].fields).toEqual([{ ...item.fields[0], sectionId: "new-section", value: "new" }]);
    expect(item.fields[0].sectionId).toBe("original-section");
  });

  it("rejects repeated edits of an original field through different aliases", async () => {
    const result = await call("item_edit", { fields: [{ idOrTitle: "password", type: "text", value: "first" }, { idOrTitle: "Password", type: "text", value: "second" }] });
    expect(result.isError).toBe(true);
    expect(put).not.toHaveBeenCalled();
  });

  it("does not resolve later edits against newly created fields", async () => {
    item.fields = [{ id: "existing", title: "Shared", fieldType: ItemFieldType.Text, value: "keep" }];
    const result = await call("item_edit", {
      fields: [
        { idOrTitle: "new-id", type: "text", value: "created" },
        { idOrTitle: "NEW-ID", type: "text", value: "overwritten" },
      ],
    });
    expect(result.isError).toBe(true);
    expect(put).not.toHaveBeenCalled();
  });

  it("rejects an edit that both removes and updates the same original field", async () => {
    const result = await call("item_edit", { removeFields: ["password"], fields: [{ idOrTitle: "Password", type: "text", value: "new" }] });
    expect(result.isError).toBe(true);
    expect(result.content).toEqual([{ type: "text", text: "Error: Conflicting field operations. Select each field only once." }]);
    expect(put).not.toHaveBeenCalled();
  });

  it.each(["item_edit", "password_update"])("%s reports a failed put without a retry", async (tool) => {
    put.mockRejectedValue(new Error("write rejected"));
    const result = await call(tool, tool === "item_edit" ? { title: "Changed" } : { newPassword: "test-value" });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain(tool === "password_update" ? "Password update failed" : "Item edit failed");
    expect(JSON.stringify(result)).not.toContain("write rejected");
    expect(put).toHaveBeenCalledTimes(1);
    expect(put.mock.calls[0][0].version).toBe(7);
  });

  it.each(["init", "vault", "get", "put"].flatMap((phase) =>
    ["raw", "base64", "base64url", "url", "nested", "cause", "hostile-error", "hostile-object"].map((format) => ({ phase, format })),
  ))("hardening: item_edit contains $phase SDK failures ($format)", async ({ phase, format }) => {
    const secret = 'synthetic-"value\\with\n?ÿ💥';
    const variants = [secret, Buffer.from(secret).toString("base64"), Buffer.from(secret).toString("base64url"), encodeURIComponent(secret)];
    const inspect = vi.fn(() => { throw new Error("synthetic-inspection-must-not-run"); });
    let failure: unknown;
    if (format === "hostile-error") {
      failure = Object.defineProperties(new Error(), {
        message: { get: inspect }, stack: { get: inspect }, cause: { get: inspect },
      });
    } else if (format === "hostile-object") {
      failure = { get message() { return inspect(); }, get stack() { return inspect(); }, get cause() { return inspect(); }, toString: inspect };
    } else {
      const message = format === "nested" ? JSON.stringify({ response: { password: secret } })
        : format === "cause" ? "Synthetic SDK failure"
        : variants[["raw", "base64", "base64url", "url"].indexOf(format)];
      failure = Object.assign(new Error(message), { cause: { response: { secret } }, raw: { password: secret } });
      (failure as Error).stack = `Synthetic SDK stack ${variants.join(" / ")}`;
    }
    const vaultList = vi.fn().mockRejectedValue(failure);
    if (phase === "init") vi.mocked(getClient).mockRejectedValueOnce(failure);
    if (phase === "vault") {
      process.env.OP_MCP_ALLOWED_VAULTS = "Allowed";
      resetConfig();
      vi.mocked(getClient).mockResolvedValue({ vaults: { list: vaultList }, items: { get, put, create, list } } as unknown as Awaited<ReturnType<typeof getClient>>);
    }
    if (phase === "get") get.mockRejectedValue(failure);
    if (phase === "put") put.mockRejectedValue(failure);

    const result = await call("item_edit", { fields: [{ idOrTitle: "password", type: "concealed", value: secret }] });
    const safeMessage = phase === "vault"
      ? "Vault 'vault-id' is not in the allowed vault list, or vault access verification failed."
      : "Item edit failed. Check item metadata before retrying; the write outcome may be unknown.";
    expect(result.isError).toBe(true);
    expect(result.content).toEqual([{ type: "text", text: `Error: ${safeMessage}` }]);
    expect(logError).toHaveBeenCalledTimes(1);
    const logged = vi.mocked(logError).mock.calls[0];
    expect(logged).toHaveLength(2);
    expect(logged[0]).toBe("item_edit failed.");
    expect(logged[1]).toBeInstanceOf(Error);
    expect(logged[1] === failure).toBe(false);
    const safeError = logged[1] as Error;
    expect(safeError.message).toBe(safeMessage);
    expect(safeError.cause).toBeUndefined();
    expect(Object.keys(safeError)).toEqual([]);
    expect(safeError.stack?.startsWith(`Error: ${safeMessage}\n`)).toBe(true);
    for (const variant of variants) {
      expect(JSON.stringify(result)).not.toContain(variant);
      expect(safeError.stack).not.toContain(variant);
    }
    expect(safeError.stack).not.toContain("Synthetic SDK stack");
    expect(inspect).not.toHaveBeenCalled();
    expect(get).toHaveBeenCalledTimes(phase === "get" || phase === "put" ? 1 : 0);
    expect(put).toHaveBeenCalledTimes(phase === "put" ? 1 : 0);
    expect(vaultList).toHaveBeenCalledTimes(phase === "vault" ? 1 : 0);
  });

  it.each(["get", "put"])("hardening: item_edit retains the unsupported SDK %s diagnostic", async (method) => {
    vi.mocked(getClient).mockResolvedValue({ items: { get, put, [method]: undefined } } as unknown as Awaited<ReturnType<typeof getClient>>);
    const result = await call("item_edit", { title: "Changed" });
    expect(result.isError).toBe(true);
    expect(result.content).toEqual([{ type: "text", text: `Error: Your @1password/sdk version does not support ${method === "get" ? "getting" : "updating"} items.` }]);
    expect(get).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
  });

  it("hardening: item_edit preserves the vault denial and blocks reads and writes", async () => {
    process.env.OP_MCP_ALLOWED_VAULTS = "Allowed";
    resetConfig();
    const vaultList = vi.fn().mockResolvedValue([{ id: "other-vault", title: "Allowed" }]);
    vi.mocked(getClient).mockResolvedValue({ vaults: { list: vaultList }, items: { get, put } } as unknown as Awaited<ReturnType<typeof getClient>>);
    const result = await call("item_edit", { title: "Changed" });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain("not in the allowed vault list");
    expect(get).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
  });

  function data(result: Awaited<ReturnType<typeof call>>) {
    const content = result.content[0];
    if (content.type !== "text") throw new Error("Expected text result");
    return JSON.parse(content.text);
  }

  it("uses seven memorable words and reports entropy from 402 distinct words", async () => {
    const result = data(await call("password_generate_memorable"));
    expect(result.password.split("-")).toHaveLength(7);
    expect(result.password).toMatch(/^[A-Z][a-z]+(?:-[A-Z][a-z]+){6}\d{1,2}[!@#$%^&*]$/);
    expect(result.dictionarySize).toBe(402);
    expect(result.entropyBits).toBeCloseTo(70.2, 2);
  });

  it("preserves explicit memorable options and excludes fixed formatting from entropy", async () => {
    const result = data(await call("password_generate_memorable", { wordCount: 7, separator: ".", includeNumber: false, includeSymbol: false, capitalize: false }));
    expect(result.password).toMatch(/^[a-z]+(?:\.[a-z]+){6}$/);
    expect(result.entropyBits).toBeCloseTo(60.56, 2);
    const short = data(await call("password_generate_memorable", { wordCount: 2, includeNumber: false, includeSymbol: false }));
    expect(short.password.split("-")).toHaveLength(2);
    expect(short.entropyBits).toBeCloseTo(17.3, 2);
  });

  it.each(["", "a"])("does not claim exact output entropy for an ambiguous separator %j", async (separator) => {
    const result = data(await call("password_generate_memorable", { separator }));
    expect(result.entropyBits).toBeUndefined();
    expect(result.samplingEntropyBits).toBeCloseTo(70.2, 2);
    expect(result.entropyNote).toContain("upper bound");
  });

  it.each(["password_create", "password_update"])("%s generates and stores random passwords without returning them", async (tool) => {
    const result = await call(tool, { title: "New", generate: { style: "random", length: 32, includeSymbols: false, includeNumbers: false, includeUppercase: false } });
    expect(result.isError).not.toBe(true);
    const saved = tool === "password_create" ? create.mock.calls[0][0] : put.mock.calls[0][0];
    const password = saved.fields!.find((field) => field.id === "password")!.value;
    expect(password).toMatch(/^[a-z]{32}$/);
    expect(JSON.stringify(result)).not.toContain(password);
    expect(data(result).password).toBeUndefined();
    expect(data(result).secretReference).toBe(`op://vault-id/${tool === "password_create" ? "created-item-id" : "item-id"}/password`);
    expect(tool === "password_create" ? create : put).toHaveBeenCalledTimes(1);
  });

  it.each(["password_create", "password_update"])("%s uses shared memorable defaults and explicit overrides", async (tool) => {
    const first = await call(tool, { title: "New", generate: { style: "memorable" } });
    expect(first.isError).not.toBe(true);
    const saved = () => tool === "password_create" ? create.mock.calls.at(-1)![0] : put.mock.calls.at(-1)![0];
    expect(saved().fields!.find((field) => field.id === "password")!.value.split("-")).toHaveLength(7);
    const second = await call(tool, { title: "New", generate: { style: "memorable", wordCount: 2, separator: ":", includeNumber: false, includeSymbol: false, capitalize: false }, returnSecret: true });
    expect(data(second).password).toMatch(/^[a-z]+:[a-z]+$/);
  });

  it.each(["password_create", "password_update"])("%s rejects both or neither value and generation before touching the SDK", async (tool) => {
    vi.mocked(getClient).mockClear();
    const input = tool === "password_create" ? "password" : "newPassword";
    for (const args of [{}, { [input]: "test-only-value", generate: { style: "random" } }]) {
      const result = await call(tool, { title: "New", ...args });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).toContain("exactly one");
    }
    expect(getClient).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
  });

  it.each(["password_create", "password_update"])("%s retains explicit password and opt-in return behavior", async (tool) => {
    const input = tool === "password_create" ? "password" : "newPassword";
    const result = await call(tool, { title: "New", [input]: "test-only-explicit", returnSecret: true });
    expect(data(result).password).toBe("test-only-explicit");
    const hidden = await call(tool, { title: "New", [input]: "test-only-explicit" });
    expect(JSON.stringify(hidden)).not.toContain("test-only-explicit");
    expect(data(hidden).secretReference).toContain("/password");
  });

  it("returns section and field IDs rather than titles for a selected password field", async () => {
    item.fields = [{ id: "field-id", title: "API token", sectionId: "section-id", fieldType: ItemFieldType.Text, value: "old" }];
    const result = await call("password_update", { field: "api token", generate: { style: "random" } });
    expect(result.isError).not.toBe(true);
    expect(data(result).secretReference).toBe("op://vault-id/item-id/section-id/field-id");
    expect(put.mock.calls[0][0].fields[0].fieldType).toBe(ItemFieldType.Concealed);
  });

  it.each(["password_create", "password_update"])("%s redacts explicit and generated secrets from SDK errors and logged exceptions", async (tool) => {
    const fail = async (value: { fields?: { value: string }[] }) => {
      const secret = value.fields![0].value;
      const error = new Error(`SDK rejected ${secret} and ${JSON.stringify(secret)} and ${encodeURIComponent(secret)}`);
      error.stack = `sensitive stack ${secret}`;
      throw error;
    };
    create.mockImplementation(fail);
    put.mockImplementation(fail);
    const input = tool === "password_create" ? "password" : "newPassword";
    for (const args of [{ [input]: 'fake-"value\\with\nnewline' }, { generate: { style: "random" } }, { generate: { style: "memorable" } }]) {
      const result = await call(tool, { title: "New", ...args });
      expect(result.isError).toBe(true);
      const saved = tool === "password_create" ? create.mock.calls.at(-1)![0] : put.mock.calls.at(-1)![0];
      const secret = saved.fields![0].value;
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain(JSON.stringify(secret).slice(1, -1));
      const logged = vi.mocked(logError).mock.calls.at(-1)![1];
      expect(logged).toBeInstanceOf(Error);
      expect(String(logged)).not.toContain(secret);
      expect((logged as Error).stack).not.toContain(secret);
      expect((logged as Error).message).not.toContain(encodeURIComponent(secret));
    }
    expect(tool === "password_create" ? create : put).toHaveBeenCalledTimes(3);
  });

  it.each(["password_create", "password_update"])("repair: %s returns and logs only fixed SDK failure messages for explicit and generated values", async (tool) => {
    const failure = async (value: { fields?: { value: string }[] }) => {
      const secret = value.fields![0].value;
      const message = [secret, Buffer.from(secret).toString("base64"), Buffer.from(secret).toString("base64url"), JSON.stringify(JSON.stringify(secret)), encodeURIComponent(secret), `first line\n${secret}\nlast line`].join(" / ");
      const error = Object.assign(new Error(message), { cause: { password: secret }, raw: value });
      error.stack = message;
      throw error;
    };
    create.mockImplementation(failure);
    put.mockImplementation(failure);
    const input = tool === "password_create" ? "password" : "newPassword";
    const safeMessage = tool === "password_create"
      ? "Password creation failed. Check item metadata before retrying; the write outcome may be unknown."
      : "Password update failed. Check item metadata before retrying; the write outcome may be unknown.";
    for (const args of [{ [input]: "abc" }, { [input]: 'synthetic-"value\\with\nnewline' }, { generate: { style: "random" } }, { generate: { style: "memorable" } }]) {
      vi.mocked(logError).mockClear();
      const result = await call(tool, { title: "Synthetic", ...args });
      expect(result.isError).toBe(true);
      const part = result.content[0];
      expect(part.type === "text" && part.text).toBe(`Error: ${safeMessage}`);
      expect(logError).toHaveBeenCalledTimes(1);
      const logged = vi.mocked(logError).mock.calls[0];
      expect(logged[0]).toBe(`${tool} failed.`);
      expect(logged[1]).toBeInstanceOf(Error);
      const error = logged[1] as Error;
      expect(error.message).toBe(safeMessage);
      expect(Object.keys(error)).toEqual([]);
      expect(error.cause).toBeUndefined();
      expect(error.stack).toMatch(new RegExp(`^Error: ${safeMessage.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\n`));
      expect(error.stack).not.toContain("synthetic-");
      expect(error.stack).not.toContain("YWJj");
    }
    expect(tool === "password_create" ? create : put).toHaveBeenCalledTimes(4);
  });

  it.each(["password_create", "password_update"])("repair: %s does not inspect an arbitrary thrown SDK object", async (tool) => {
    const inspect = vi.fn(() => { throw new Error("synthetic-leak-if-inspected"); });
    const failure = { get message() { return inspect(); }, get stack() { return inspect(); }, toString: inspect };
    create.mockRejectedValue(failure);
    put.mockRejectedValue(failure);
    const result = await call(tool, { title: "Synthetic", generate: { style: "random" } });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain(tool === "password_create" ? "Password creation failed" : "Password update failed");
    expect(inspect).not.toHaveBeenCalled();
    expect(logError).toHaveBeenCalledTimes(1);
    expect(vi.mocked(logError).mock.calls[0][1]).not.toBe(failure);
  });

  it("repair: unique title retains section identity after one successful write", async () => {
    item.sections = [{ id: "s1", title: "First" }, { id: "s2", title: "Second" }];
    item.fields = [
      { id: "token", title: "First token", sectionId: "s1", fieldType: ItemFieldType.Text, value: "old-first" },
      { id: "token", title: "Second token", sectionId: "s2", fieldType: ItemFieldType.Concealed, value: "old-second" },
    ];
    const before = structuredClone(item);
    const result = await call("password_update", { field: "First token", newPassword: "synthetic-new-password" });
    expect(result.isError).not.toBe(true);
    expect(data(result).secretReference).toBe("op://vault-id/item-id/s1/token");
    expect(put).toHaveBeenCalledTimes(1);
    const saved = put.mock.calls[0][0];
    expect(saved.fields).toEqual([{ ...before.fields[0], value: "synthetic-new-password", fieldType: ItemFieldType.Concealed }, before.fields[1]]);
    expect(saved.version).toBe(7);
    expect(item).toEqual(before);
    get.mockResolvedValue(saved);
    const checked = await call("op_check_ref", { secretReference: data(result).secretReference });
    expect(checked.isError).not.toBe(true);
    expect(data(checked).field).toEqual({ id: "token", title: "First token", type: ItemFieldType.Concealed, section: "s1" });
    expect(JSON.stringify(checked)).not.toContain("synthetic-");
    expect(get).toHaveBeenCalledTimes(2);
    expect(put).toHaveBeenCalledTimes(1);
  });

  it.each(["password_create", "password_update"])("repair: %s hides SDK initialization and vault verification exceptions", async (tool) => {
    const failure = Object.assign(new Error("synthetic-encoded-YWJj"), { cause: { password: "abc" } });
    vi.mocked(getClient).mockRejectedValueOnce(failure);
    let result = await call(tool, { title: "Synthetic", generate: { style: "random" } });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).not.toContain("synthetic-encoded");
    expect(vi.mocked(logError).mock.calls.at(-1)![1]).not.toBe(failure);
    process.env.OP_MCP_ALLOWED_VAULTS = "Allowed";
    resetConfig();
    const vaultList = vi.fn().mockRejectedValue(failure);
    vi.mocked(getClient).mockResolvedValue({ vaults: { list: vaultList }, items: { get, put, create, list } } as unknown as Awaited<ReturnType<typeof getClient>>);
    result = await call(tool, { title: "Synthetic", generate: { style: "random" } });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain("vault access verification failed");
    expect(JSON.stringify(result)).not.toContain("synthetic-encoded");
    expect(vi.mocked(logError).mock.calls.at(-1)![1]).not.toBe(failure);
    expect(get).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it("repair: password_update hides SDK read exceptions before a write", async () => {
    const failure = new Error("synthetic-old-password-YWJj");
    get.mockRejectedValue(failure);
    const result = await call("password_update", { generate: { style: "random" } });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).not.toContain("synthetic-old-password");
    expect(vi.mocked(logError).mock.calls.at(-1)![1]).not.toBe(failure);
    expect(put).not.toHaveBeenCalled();
  });

  it("repair: repeated bare field IDs fail before a write", async () => {
    item.fields = ["s1", "s2"].map((sectionId) => ({ id: "token", title: sectionId, sectionId, fieldType: ItemFieldType.Concealed, value: `old-${sectionId}` }));
    const result = await call("password_update", { field: "token", newPassword: "synthetic-new-password" });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain("Ambiguous field");
    expect(JSON.stringify(result)).toContain("s1");
    expect(JSON.stringify(result)).toContain("s2");
    expect(JSON.stringify(result)).not.toContain("old-");
    expect(put).not.toHaveBeenCalled();
  });

  it.each(["password_create", "password_update"])("repair: %s references pass actual op_check_ref with or without a section", async (tool) => {
    for (const sectionId of [undefined, "section-id"]) {
      const saved = { ...fixture(), id: tool === "password_create" ? "created-item-id" : "item-id", fields: [{ ...fixture().fields[0], sectionId }] };
      create.mockResolvedValue(saved);
      put.mockResolvedValue(saved);
      item.fields = saved.fields;
      get.mockResolvedValue(saved);
      const result = await call(tool, { title: "Synthetic", generate: { style: "random" } });
      expect(result.isError).not.toBe(true);
      const reference = data(result).secretReference;
      expect(reference).toBe(`op://vault-id/${saved.id}/${sectionId ? `${sectionId}/` : ""}password`);
      get.mockResolvedValue(saved);
      const checked = await call("op_check_ref", { secretReference: reference });
      expect(resolveAll).toHaveBeenLastCalledWith([reference]);
      expect(checked.isError).not.toBe(true);
      expect(data(checked).field).toEqual({ id: "password", title: "Password", type: ItemFieldType.Concealed, ...(sectionId ? { section: sectionId } : {}) });
      expect(JSON.stringify(checked)).not.toContain("old-test-value");
      expect(JSON.stringify(checked)).not.toContain("synthetic-resolved-value");
    }
  });

  it("repair: section-qualified validation cannot match another section", async () => {
    item.sections = [{ id: "s1", title: "First" }, { id: "s2", title: "Second" }];
    item.fields = [
      { id: "token", title: "First token", sectionId: "s1", fieldType: ItemFieldType.Concealed, value: "hidden-one" },
      { id: "token", title: "Second token", sectionId: "s2", fieldType: ItemFieldType.Concealed, value: "hidden-two" },
    ];
    for (const section of ["s2", "S2", "Second"]) {
      const result = await call("op_check_ref", { secretReference: `op://vault-id/item-id/${section}/token` });
      expect(result.isError).not.toBe(true);
      expect(data(result).field.title).toBe("Second token");
      expect(data(result).field.section).toBe("s2");
      expect(JSON.stringify(result)).not.toContain("hidden-");
    }
    const missing = await call("op_check_ref", { secretReference: "op://vault-id/item-id/missing/token" });
    expect(missing.isError).toBe(true);
    const bare = await call("op_check_ref", { secretReference: "op://vault-id/item-id/token" });
    expect(bare.isError).toBe(true);
    expect(JSON.stringify(bare)).toContain("Ambiguous field");
  });

  it("repair: op_check_ref retains name, ID, legacy-label, and encoded-literal behavior", async () => {
    item.fields = [{ ...item.fields[0], id: "CamelID", title: "Friendly token", label: "Old label" } as Item["fields"][number]];
    for (const field of ["CamelID", "camelid", "FRIENDLY TOKEN", "OLD LABEL"]) {
      const result = await call("op_check_ref", { secretReference: `op://vault-id/item-id/${field}` });
      expect(result.isError).not.toBe(true);
      expect(data(result).field.id).toBe("CamelID");
    }
    item.fields = [{ ...item.fields[0], id: "token%2Fid?attribute=password", sectionId: "section%20id" }];
    const reference = "op://vault-id/item-id/section%20id/token%2Fid?attribute=password";
    const result = await call("op_check_ref", { secretReference: reference });
    expect(result.isError).not.toBe(true);
    expect(resolveAll).toHaveBeenLastCalledWith([reference]);
    expect(data(result).field.id).toBe("token%2Fid?attribute=password");
  });

  it.each(["password_create", "password_update"])("repair: %s returned section reference retains resolved-vault enforcement", async (tool) => {
    item.fields[0].sectionId = "section-id";
    const saved = { ...item, id: tool === "password_create" ? "created-item-id" : item.id };
    create.mockResolvedValue(saved);
    put.mockResolvedValue(saved);
    const written = await call(tool, { title: "Synthetic", generate: { style: "random" } });
    expect(written.isError).not.toBe(true);
    const reference = data(written).secretReference;
    expect(reference).toContain("/section-id/password");
    const vaultList = vi.fn(async () => [{ id: "vault-id", title: "Allowed" }, { id: "denied-id", title: "Denied" }]);
    vi.mocked(getClient).mockResolvedValue({ vaults: { list: vaultList }, items: { get, put, create, list }, secrets: { resolveAll } } as unknown as Awaited<ReturnType<typeof getClient>>);
    process.env.OP_MCP_ALLOWED_VAULTS = "vault-id";
    resetConfig();
    get.mockClear();
    resolveAll.mockResolvedValue({ individualResponses: { [reference]: { content: { vaultId: "denied-id", itemId: saved.id, secret: "hidden-resolver-value" } } } });
    const denied = await call("op_check_ref", { secretReference: reference });
    expect(denied.isError).toBe(true);
    expect(JSON.stringify(denied)).toContain("not in the allowed vault list");
    expect(JSON.stringify(denied)).not.toContain("hidden-resolver-value");
    expect(get).not.toHaveBeenCalled();
    resolveAll.mockClear();
    process.env.OP_MCP_ALLOWED_VAULTS = "Another vault";
    resetConfig();
    const preDenied = await call("op_check_ref", { secretReference: reference });
    expect(preDenied.isError).toBe(true);
    expect(resolveAll).not.toHaveBeenCalled();
  });

  it.each(["password_create", "password_update"])("repair: %s reports successful writes with a fixed warning for unusable saved metadata", async (tool) => {
    const warning = "Password saved, but no reliable secret reference is available from the SDK response. Do not retry the write; inspect item metadata.";
    const base = fixture();
    const badMetadata = [
      { ...base, fields: [] },
      { ...base, fields: undefined },
      { ...base, fields: [base.fields[0], { ...base.fields[0] }] },
      { ...base, fields: [{ ...base.fields[0], id: "" }] },
      { ...base, vaultId: "" },
      { ...base, id: "item/with/slashes" },
    ];
    for (const saved of badMetadata) {
      create.mockResolvedValue(saved as Item);
      put.mockResolvedValue(saved as Item);
      const before = (tool === "password_create" ? create : put).mock.calls.length;
      const result = await call(tool, { title: "Synthetic", generate: { style: "random" } });
      expect(result.isError).not.toBe(true);
      expect(data(result)).toEqual({ id: saved.id, title: saved.title, vaultId: saved.vaultId, ...(tool === "password_create" ? { category: saved.category } : {}), warning });
      expect(data(result).secretReference).toBeUndefined();
      expect(data(result).password).toBeUndefined();
      expect(tool === "password_create" ? create : put).toHaveBeenCalledTimes(before + 1);
    }
    expect(logError).not.toHaveBeenCalled();
  });

  it.each(["item_list", "item_lookup"])("%s pages in stable title/ID order and returns only allowed metadata", async (tool) => {
    const first = data(await call(tool, { pageSize: 1 }));
    expect(first.items.map((entry: { id: string }) => entry.id)).toEqual(["a"]);
    expect(first.count).toBe(1);
    expect(first.nextCursor).toEqual(expect.any(String));
    const second = data(await call(tool, { pageSize: 1, cursor: first.nextCursor }));
    expect(second.items.map((entry: { id: string }) => entry.id)).toEqual(["b"]);
    const last = data(await call(tool, { pageSize: 1, cursor: second.nextCursor }));
    expect(last.items.map((entry: { id: string }) => entry.id)).toEqual(["z"]);
    expect(last.nextCursor).toBeNull();
    expect(JSON.stringify([first, second, last])).not.toMatch(/old-test-value|fields|Keep notes|websites/);
    expect(get).not.toHaveBeenCalled();
    expect(list).toHaveBeenCalledTimes(3);
  });

  it.each(["item_list", "item_lookup"])("%s preserves the unpaged response and SDK order, and filters tags locally", async (tool) => {
    const legacy = data(await call(tool));
    expect(Object.keys(legacy).sort()).toEqual(["count", "items"]);
    expect(legacy.items.map((entry: { id: string }) => entry.id)).toEqual(["z", "b", "a"]);
    const tagged = data(await call(tool, { tag: "team" }));
    expect(tagged.items.map((entry: { id: string }) => entry.id)).toEqual(["z", "b"]);
    expect(get).not.toHaveBeenCalled();
    const none = data(await call(tool, { tag: "missing", pageSize: 2 }));
    expect(none).toEqual({ items: [], count: 0, nextCursor: null });
    overviews = [];
    expect(data(await call(tool, { pageSize: 1 }))).toEqual({ items: [], count: 0, nextCursor: null });
  });

  it.each(["item_list", "item_lookup"])("%s rejects malformed, changed-filter, changed-vault, and cross-tool cursors", async (tool) => {
    const first = data(await call(tool, { pageSize: 1, tag: "team" }));
    for (const args of [
      { cursor: "bad" },
      { cursor: first.nextCursor, tag: "prod" },
      { cursor: first.nextCursor, tag: "team", vaultId: "other-vault" },
      { cursor: first.nextCursor + "x", tag: "team" },
    ]) {
      expect((await call(tool, args)).isError).toBe(true);
    }
    expect((await call(tool === "item_list" ? "item_lookup" : "item_list", { cursor: first.nextCursor, tag: "team" })).isError).toBe(true);
  });

  it("keeps lookup limit behavior and binds cursors to query and limit", async () => {
    expect(data(await call("item_lookup", { query: "aLPhA", limit: 1 })).items[0].id).toBe("b");
    const first = data(await call("item_lookup", { query: "aLPhA", limit: 2, pageSize: 1 }));
    expect(first.items[0].id).toBe("a");
    expect((await call("item_lookup", { query: "Beta", limit: 2, cursor: first.nextCursor })).isError).toBe(true);
    expect((await call("item_lookup", { query: "alpha", limit: 1, cursor: first.nextCursor })).isError).toBe(true);
    const last = data(await call("item_lookup", { query: "alpha", limit: 2, pageSize: 1, cursor: first.nextCursor }));
    expect(last.items[0].id).toBe("b");
    expect(last.nextCursor).toBeNull();
  });

  it.each(["item_list", "item_lookup"])("%s rejects invalid page sizes and list failures", async (tool) => {
    for (const pageSize of [0, 201, 1.5]) expect((await call(tool, { pageSize })).isError).toBe(true);
    expect(list).not.toHaveBeenCalled();
    list.mockRejectedValue(new Error("list failed"));
    expect((await call(tool, { pageSize: 1 })).isError).toBe(true);
  });

  it("repair: prompts handle missing references, fixed failures, and real field discovery metadata", async () => {
    for (const name of ["generate-secure-password", "credential-rotation"]) {
      const prompt = JSON.stringify(await client.getPrompt({ name, arguments: {} }));
      expect(prompt).toContain("warning");
      expect(prompt).toContain("Do not retry");
      expect(prompt).toContain("fixed");
      expect(prompt).toContain("item metadata");
    }
    const reference = JSON.stringify(await client.getPrompt({ name: "secret-reference-helper", arguments: {} }));
    expect(reference).toContain("item_get");
    expect(reference).toContain("section");
    expect(reference).toContain("reveal: false");
    expect(reference).not.toContain("password_read");
    expect(reference).toContain("op_check_ref");
  });

  it("advertises generation choices and safe creation, rotation, and bounded-page prompts", async () => {
    const tools = await client.listTools();
    for (const name of ["password_create", "password_update"]) {
      const schema = tools.tools.find((tool) => tool.name === name)!.inputSchema;
      expect(schema.properties).toHaveProperty("generate");
      expect(schema.required).not.toContain(name === "password_create" ? "password" : "newPassword");
    }
    const text = async (name: string, args: Record<string, string> = {}) => JSON.stringify(await client.getPrompt({ name, arguments: args }));
    const creation = await text("generate-secure-password", { style: "memorable" });
    expect(creation).toContain("password_create");
    expect(creation).toContain("generate");
    expect(creation).toContain("7 words");
    expect(creation).toContain("402");
    expect(creation).toContain("70.2");
    const rotation = await text("credential-rotation");
    expect(rotation).toContain("password_update");
    expect(rotation).toContain("generate");
    expect(rotation).not.toContain("password_generate");
    expect(rotation).toContain("external");
    const audit = await text("vault-audit");
    expect(audit).toContain("pageSize");
    expect(audit).toContain("nextCursor");
    expect(audit).not.toContain("high limit");
  });

  it.each(["password_create", "password_update"])("%s rejects invalid generation options without SDK access", async (tool) => {
    vi.mocked(getClient).mockClear();
    for (const generate of [{ style: "other" }, { style: "random", length: 7 }, { style: "memorable", wordCount: 11 }, { style: "memorable", separator: "123456" }]) {
      expect((await call(tool, { title: "New", generate })).isError).toBe(true);
    }
    expect(getClient).not.toHaveBeenCalled();
  });

  it("keeps pagination bounded at 200 and supports a cursor without a page size", async () => {
    overviews = Array.from({ length: 202 }, (_, index) => ({ ...overviews[0], id: String(index).padStart(3, "0"), title: "Same" }));
    const first = data(await call("item_list", { pageSize: 200 }));
    expect(first.count).toBe(200);
    const last = data(await call("item_list", { cursor: first.nextCursor }));
    expect(last.count).toBe(2);
    expect(last.nextCursor).toBeNull();
  });

  it("rejects a cursor outside a changed result set", async () => {
    const first = data(await call("item_list", { pageSize: 2 }));
    overviews = [];
    expect((await call("item_list", { cursor: first.nextCursor })).isError).toBe(true);
  });

  it("supports a unique legacy password label without changing its metadata", async () => {
    const legacy = { ...item.fields[0], id: "old-id", title: "Old title", label: "Legacy password", sectionId: "section-id" };
    item.fields = [legacy];
    const result = await call("password_update", { field: "LEGACY PASSWORD", newPassword: "test-value" });
    expect(result.isError).not.toBe(true);
    expect(put.mock.calls[0][0].fields[0]).toEqual({ ...legacy, value: "test-value" });
    expect(data(result).secretReference).toBe("op://vault-id/item-id/section-id/old-id");
  });

  it("uses empty tag metadata when an SDK list result omits tags", async () => {
    Reflect.deleteProperty(overviews[0], "tags");
    const result = data(await call("item_list"));
    expect(result.items[0].tags).toEqual([]);
    const filtered = data(await call("item_list", { tag: "team" }));
    expect(filtered.items.map((entry: { id: string }) => entry.id)).toEqual(["b"]);
    expect(get).not.toHaveBeenCalled();
  });

  it("adds a first website when none exists", async () => {
    await call("item_edit", { url: "https://new.example" });
    expect(put.mock.calls[0][0].websites).toEqual([expect.objectContaining({ url: "https://new.example" })]);
  });

  it("preserves websites exactly when URL is omitted", async () => {
    item.websites = [{ url: "https://old.example", label: "Keep", autofillBehavior: AutofillBehavior.Never }];
    await call("item_edit", { title: "New title" });
    expect(put.mock.calls[0][0].websites).toEqual(item.websites);
  });
});
