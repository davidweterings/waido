import type { WideEventEmitter } from "#src/types.js";

export interface ConsoleEmitterOptions {
  pretty?: boolean;
  writer?: (payload: string) => void;
}

export function createConsoleEmitter(options: ConsoleEmitterOptions = {}): WideEventEmitter {
  const writer = options.writer ?? ((payload: string) => console.log(payload));

  return (event) => {
    writer(JSON.stringify(event, null, options.pretty ? 2 : undefined));
  };
}
