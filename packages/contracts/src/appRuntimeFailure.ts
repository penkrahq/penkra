// FILE: appRuntimeFailure.ts
// Purpose: Defines the bounded, role-labelled App runtime failure representation crossing IPC.
// Layer: Shared schema-only contracts

export interface AppRuntimeFailureTruncation {
  secondaryBranchesRemoved?: number;
  messageCut?: boolean;
}

export type AppRuntimeFailureDto =
  | {
      kind: "leaf";
      code?: string;
      message: string;
      truncation?: AppRuntimeFailureTruncation;
    }
  | {
      kind: "operation";
      message: string;
      primary: AppRuntimeFailureDto;
      secondary: Array<{ role: string; failure: AppRuntimeFailureDto }>;
      truncation?: AppRuntimeFailureTruncation;
    }
  | {
      kind: "group";
      message: string;
      failures: Array<{ role: string; failure: AppRuntimeFailureDto }>;
      truncation?: AppRuntimeFailureTruncation;
    };

export interface AppRuntimeBridgeError {
  code: string;
  message: string;
  failure?: AppRuntimeFailureDto;
  truncation?: { totalBytesExceeded?: boolean };
}
