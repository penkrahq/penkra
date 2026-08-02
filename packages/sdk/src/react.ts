import { useEffect, useRef, useState } from "react";

import type { OperationContext } from "./operations";
import type { PenkraPermissionName } from "./permissions";
import {
  operations,
  permissions,
  tab,
  type AppOperationHandler,
  type AppPermissionStatus,
  type AppTabNavigationHandler,
  type AppTabOperationHandler,
} from "./runtime";

function useLatest<Value>(value: Value) {
  const ref = useRef(value);
  ref.current = value;
  return ref;
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

export function useOperation<Input = unknown, Result = unknown>(
  key: string,
  handler: (input: Input, context: OperationContext) => Promise<Result> | Result,
): void {
  const latest = useLatest(handler);
  useEffect(
    () => operations.handle<Input, Result>(key, (input, context) => latest.current(input, context)),
    [key, latest],
  );
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

export type { AppOperationHandler, AppPermissionStatus };
