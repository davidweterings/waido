import type { WideEventDrain } from "#src/types.js";

export interface ConsoleDrainOptions {
  pretty?: boolean;
  writer?: (payload: string) => void;
}

/** Writes each event as one JSON line: a canonical log line. */
export function createConsoleDrain(options: ConsoleDrainOptions = {}): WideEventDrain {
  const writer = options.writer ?? ((payload: string) => console.log(payload));

  return (event) => {
    writer(JSON.stringify(event, null, options.pretty ? 2 : undefined));
  };
}
