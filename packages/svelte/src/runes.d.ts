declare function $state<T>(initial: T): T;
declare function $effect(effect: () => void | (() => void)): void;
declare namespace $effect {
  function root(effect: () => void | (() => void)): () => void;
}
