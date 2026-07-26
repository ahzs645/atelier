declare function $state<T>(initial: T): T;
declare function $effect(effect: () => void | (() => void)): void;
