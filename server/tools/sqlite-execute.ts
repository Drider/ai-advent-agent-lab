// Keep the public async tool contract while exposing synchronous SQLite work to the durable recorder.
export function sqliteExecute<Args extends unknown[], Result>(execute: (...args: Args) => Result) {
  return Object.assign(async (...args: Args) => execute(...args), { sqlite: execute })
}
