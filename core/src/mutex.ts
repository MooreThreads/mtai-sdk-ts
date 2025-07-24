export function asyncMutex() {
    let locked: boolean = false
    const waitingQueue: (() => void)[] = []

    const acquire = async (): Promise<() => void> => {
        if (!locked) {
            locked = true
            return () => release()
        }

        return new Promise<() => void>((resolve) => {
            waitingQueue.push(() => {
                locked = true
                resolve(() => release())
            })
        })
    }

    const release = (): void => {
        if (waitingQueue.length > 0) {
            const next = waitingQueue.shift()!
            next()
        } else {
            locked = false
        }
    }

    const isLocked = (): boolean => {
        return locked
    }

    return { acquire, release, isLocked }
}

