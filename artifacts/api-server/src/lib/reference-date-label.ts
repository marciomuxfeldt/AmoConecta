export type ReferenceDateMeaning =
  | "compra"
  | "acesso"
  | "criacao_conta"
  | "outro";

export function referenceDateLabel(
  meaning: string | null | undefined,
  customLabel?: string | null,
): string {
  switch (meaning) {
    case "compra":
      return "Última compra";
    case "acesso":
      return "Último acesso";
    case "criacao_conta":
      return "Criação da conta";
    case "outro":
      return customLabel?.trim() || "Outra data de referência";
    default:
      return "Data de referência (sem rótulo)";
  }
}

export function sameReferenceDateMeaning(
  leftMeaning: string | null | undefined,
  leftCustomLabel: string | null | undefined,
  rightMeaning: string | null | undefined,
  rightCustomLabel: string | null | undefined,
): boolean {
  return leftMeaning === rightMeaning &&
    (leftMeaning !== "outro" ||
      (leftCustomLabel ?? "").trim() === (rightCustomLabel ?? "").trim());
}
