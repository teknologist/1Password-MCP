import type { ItemField } from "@1password/sdk";

export function selectFieldIndex(
  fields: readonly ItemField[],
  idOrTitle: string,
  allowLegacyLabel = false,
): number {
  const target = idOrTitle.toLowerCase();
  const unique = (indices: number[]): number => {
    if (indices.length > 1) {
      const candidates = indices.map((index) => ({ id: fields[index].id, sectionId: fields[index].sectionId }));
      throw new Error(`Ambiguous field. Select a unique field ID. Candidates: ${JSON.stringify(candidates)}`);
    }
    return indices[0] ?? -1;
  };
  const exactIds = fields.flatMap((field, index) => field.id === idOrTitle ? [index] : []);
  if (exactIds.length) return unique(exactIds);
  const ids = fields.flatMap((field, index) => field.id?.toLowerCase() === target ? [index] : []);
  if (ids.length) return unique(ids);
  return unique(fields.flatMap((field, index) => {
    const label = allowLegacyLabel && "label" in field && typeof field.label === "string" ? field.label : undefined;
    return field.title?.toLowerCase() === target || label?.toLowerCase() === target ? [index] : [];
  }));
}
