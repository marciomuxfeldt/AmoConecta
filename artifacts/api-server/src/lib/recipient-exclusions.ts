import { recordsFromStream, ImportValidationError, normalizeEmail, isValidEmail } from "./csv-import";

export async function emailsFromExclusionCsv(csv: string): Promise<string[]> {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(csv));
      controller.close();
    },
  });
  const records = recordsFromStream(stream);
  const first = await records.next();
  if (first.done) throw new ImportValidationError("O CSV de exclusão está vazio.");
  const index = first.value.values.findIndex((header) =>
    ["email", "e-mail", "e mail", "user_email"].includes(header.replace(/^\uFEFF/u, "").trim().toLowerCase()),
  );
  if (index < 0) throw new ImportValidationError("O CSV de exclusão precisa de uma coluna email.");
  const emails = new Set<string>();
  for await (const record of records) {
    const email = normalizeEmail(record.values[index] ?? "");
    if (!isValidEmail(email)) {
      throw new ImportValidationError(`E-mail inválido na linha ${record.line}. Nenhuma exclusão foi aplicada.`);
    }
    emails.add(email);
    if (emails.size > 50_000) throw new ImportValidationError("O CSV de exclusão excede 50.000 endereços.");
  }
  if (!emails.size) throw new ImportValidationError("O CSV não contém endereços.");
  return [...emails];
}