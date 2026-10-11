import * as Schema from "effect/Schema";
import * as Record from "effect/Record";
import { useCallback, useEffect, useState } from "react";

const isomorphicLocalStorage: Storage =
  typeof window !== "undefined"
    ? window.localStorage
    : (function () {
        const store = new Map<string, string>();
        return {
          clear: () => store.clear(),
          getItem: (_) => store.get(_) ?? null,
          key: (_) => Record.keys(store).at(_) ?? null,
          get length() {
            return store.size;
          },
          removeItem: (_) => store.delete(_),
          setItem: (_, value) => store.set(_, value),
        };
      })();

const decode = <T, E>(schema: Schema.Codec<T, E>, value: string) =>
  Schema.decodeSync(Schema.fromJsonString(schema))(value);

const encode = <T, E>(schema: Schema.Codec<T, E>, value: T) =>
  Schema.encodeSync(Schema.fromJsonString(schema))(value);

export const getLocalStorageItem = <T, E>(key: string, schema: Schema.Codec<T, E>): T | null => {
  const item = isomorphicLocalStorage.getItem(key);
  return item ? decode(schema, item) : null;
};

export const setLocalStorageItem = <T, E>(key: string, value: T, schema: Schema.Codec<T, E>) => {
  const valueToSet = encode(schema, value);
  isomorphicLocalStorage.setItem(key, valueToSet);
};

export const removeLocalStorageItem = (key: string) => {
  isomorphicLocalStorage.removeItem(key);
};

const LOCAL_STORAGE_CHANGE_EVENT = "penkra:local_storage_change";

interface LocalStorageChangeDetail {
  key: string;
}

function dispatchLocalStorageChange(key: string) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<LocalStorageChangeDetail>(LOCAL_STORAGE_CHANGE_EVENT, {
      detail: { key },
    }),
  );
}

/**
 * The one place that reads a key and survives a corrupt or undecodable entry.
 *
 * All three read sites below (initial state, key change, cross-tab sync) need exactly this, and it
 * lives at module scope on purpose: React Compiler cannot lower a `??` inside a `try` block, so an
 * inlined copy would make the whole hook — which most of the app calls — skip compilation.
 */
function readLocalStorageItemOrFallback<T, E>(
  key: string,
  fallback: T,
  schema: Schema.Codec<T, E>,
): T {
  try {
    const item = getLocalStorageItem(key, schema);
    return item ?? fallback;
  } catch (error) {
    console.error("[LOCALSTORAGE] Error:", error);
    return fallback;
  }
}

/** Persists one write, mirroring `useState`'s updater-or-value contract. Module scope: see above. */
function persistLocalStorageValue<T, E>(
  key: string,
  previous: T,
  value: T | ((val: T) => T),
  schema: Schema.Codec<T, E>,
): T {
  const valueToStore = typeof value === "function" ? (value as (val: T) => T)(previous) : value;
  try {
    if (valueToStore === null) {
      removeLocalStorageItem(key);
    } else {
      setLocalStorageItem(key, valueToStore, schema);
    }
    // Dispatch event after state update completes to avoid nested state updates
    queueMicrotask(() => dispatchLocalStorageChange(key));
  } catch (error) {
    console.error("[LOCALSTORAGE] Error:", error);
  }
  return valueToStore;
}

export function useLocalStorage<T, E>(
  key: string,
  initialValue: T,
  schema: Schema.Codec<T, E>,
): [T, (value: T | ((val: T) => T)) => void] {
  const [stored, setStored] = useState(() => ({
    key,
    value: readLocalStorageItemOrFallback(key, initialValue, schema),
  }));

  // A changed key owns a different value; adjust both before React commits it.
  if (stored.key !== key) {
    setStored({ key, value: readLocalStorageItemOrFallback(key, initialValue, schema) });
  }

  const setValue = useCallback(
    (value: T | ((val: T) => T)) => {
      setStored((previous) => ({
        key,
        value: persistLocalStorageValue(key, previous.value, value, schema),
      }));
    },
    [key, schema],
  );

  // Listen for storage events from other tabs AND custom events from the same tab
  useEffect(() => {
    const syncFromStorage = () => {
      setStored({ key, value: readLocalStorageItemOrFallback(key, initialValue, schema) });
    };

    const handleStorageChange = (event: StorageEvent) => {
      if (event.key === key) {
        syncFromStorage();
      }
    };

    const handleLocalChange = (event: CustomEvent<LocalStorageChangeDetail>) => {
      if (event.detail.key === key) {
        syncFromStorage();
      }
    };

    window.addEventListener("storage", handleStorageChange);
    window.addEventListener(LOCAL_STORAGE_CHANGE_EVENT, handleLocalChange as EventListener);

    return () => {
      window.removeEventListener("storage", handleStorageChange);
      window.removeEventListener(LOCAL_STORAGE_CHANGE_EVENT, handleLocalChange as EventListener);
    };
  }, [key, initialValue, schema]);

  return [stored.value, setValue];
}
