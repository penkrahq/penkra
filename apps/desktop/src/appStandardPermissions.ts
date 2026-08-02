export const APP_STANDARD_PERMISSIONS = {
  microphone: "Use the microphone",
  camera: "Use the camera",
  notifications: "Show notifications",
  "clipboard-read": "Read the clipboard",
} as const;

export type AppStandardPermissionName = keyof typeof APP_STANDARD_PERMISSIONS;

export function isAppStandardPermissionName(value: string): value is AppStandardPermissionName {
  return Object.hasOwn(APP_STANDARD_PERMISSIONS, value);
}
