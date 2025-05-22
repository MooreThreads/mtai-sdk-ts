import { abortable } from "./abortable";
import { dh2dHooks } from "./dh2d/hooks";
import { createLogger } from "./log";
import { DH2DSessionConfig } from "./dh2d/types";
import { DH2DPlayerElements } from "./dh2d/types";


export const hooks = {
    dh2d: dh2dHooks,
    logger: createLogger(console).push((_, ...args) => _(new Date().toISOString(), ...args))
}