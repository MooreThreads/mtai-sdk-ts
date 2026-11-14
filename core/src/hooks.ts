import { dh2dHooks } from "./dh2d/hooks";
import { createLogger } from "./log";


export const hooks = {
    dh2d: dh2dHooks,
    logger: createLogger(console).push((_, ...args) => _(new Date().toISOString(), ...args))
}