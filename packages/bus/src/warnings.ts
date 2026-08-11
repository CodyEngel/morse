/**
 * Side-effect module: silences the `node:sqlite` ExperimentalWarning.
 *
 * Must be imported *before* anything that pulls in `node:sqlite`. ESM evaluates
 * imported modules in declaration order, so a bare `import './warnings.js'` at
 * the top of an entrypoint is enough.
 *
 * We only swallow the one warning we expect; everything else still surfaces.
 */
const original = process.emitWarning.bind(process);

process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
  const type = typeof rest[0] === "string" ? rest[0] : (rest[0] as { type?: string } | undefined)?.type;
  const text = typeof warning === "string" ? warning : warning?.message ?? "";
  if (type === "ExperimentalWarning" && /SQLite/i.test(text)) return;
  return (original as (...args: unknown[]) => void)(warning, ...rest);
}) as typeof process.emitWarning;
