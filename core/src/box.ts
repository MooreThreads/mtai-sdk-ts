import { events } from "./events";
import { Box } from "./types";

export function box<T>(value: T): Box<T> {
    const evt = events<Box<T>>()
    let v = value
    return {
        set value(next: T) {
            v = next
            evt.emit("value", next)
        },
        get value() {
            return v
        },
        on: evt.on,
        off: evt.off,
    }
}

