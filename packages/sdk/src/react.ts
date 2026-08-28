import { useEffect, useRef, useState } from "react";

import type { PenkraPermissionName } from "./permissions";
import {
  permissions,
  identity,
  settings,
  tab,
  type AppIdentity,
  type AppPermissionStatus,
  type AppTabNavigationHandler,
  type AppTabOperationHandler,
} from "./runtime";

function useLatest<Value>(value: Value) {
  const ref = useRef(value);
  ref.current = value;
  return ref;
}

export function useIdentity() {
  const [value, setValue] = useState<AppIdentity | null>(null);
  const [error, setError] = useState<Error | null>(null);
  useEffect(() => {
    let active = true;
    void identity.get().then(
      (next) => active && setValue(next),
      (cause) => active && setError(cause instanceof Error ? cause : new Error(String(cause))),
    );
    return () => {
      active = false;
    };
  }, []);
  return { identity: value, error } as const;
}

export function usePermission(name: PenkraPermissionName) {
  const [status, setStatus] = useState<AppPermissionStatus | null>(null);
  const [error, setError] = useState<Error | null>(null);
  useEffect(() => {
    let active = true;
    void permissions.query(name).then(
      (next) => active && setStatus(next),
      (cause) => active && setError(cause instanceof Error ? cause : new Error(String(cause))),
    );
    return () => {
      active = false;
    };
  }, [name]);
  return { status, error } as const;
}

export function useAppSetting<Value extends boolean | number | string>(key: string) {
  const [value, setValue] = useState<Value | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let active = true;
    void settings.get(key).then(
      (next) => active && setValue(next as Value),
      (cause) => active && setError(cause instanceof Error ? cause : new Error(String(cause))),
    );
    return () => {
      active = false;
    };
  }, [key, revision]);
  return {
    value,
    error,
    set: async (next: Value) => {
      await settings.set(key, next);
      setValue(next);
      setError(null);
    },
    reset: async () => {
      await settings.reset(key);
      setRevision((current) => current + 1);
      setError(null);
    },
  } as const;
}

export function useTabOperation<Input = unknown, Result = unknown>(
  key: string,
  handler: AppTabOperationHandler<Input, Result>,
): void {
  const latest = useLatest(handler);
  useEffect(
    () => tab.handle<Input, Result>(key, (input, context) => latest.current(input, context)),
    [key, latest],
  );
}

export function useTabNavigation<Result = void>(handler: AppTabNavigationHandler<Result>): void {
  const latest = useLatest(handler);
  useEffect(() => tab.onNavigate((input, context) => latest.current(input, context)), [latest]);
}

export type { AppIdentity, AppPermissionStatus };
