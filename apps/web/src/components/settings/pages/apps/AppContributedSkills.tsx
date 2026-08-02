import { SwitchShared } from "~/components/foundations/switch-shared/SwitchShared";
import { SettingRowShared } from "~/components/settings/setting-row-shared/SettingRowShared";
import { SettingsSectionShared } from "~/components/settings/settings-section-shared/SettingsSectionShared";
import { toastManager } from "~/components/ui/toast";
import { setInstalledAppSkillEnabled } from "~/appInstallationStore";

export function AppContributedSkills({
  appId,
  appName,
  skills,
  spaceId,
  overrides,
}: {
  appId: string;
  appName: string;
  skills: ReadonlyArray<{ path: string }>;
  spaceId: string;
  overrides: Readonly<Record<string, boolean>>;
}) {
  if (skills.length === 0) return null;
  return (
    <SettingsSectionShared className="mt-2" title={`${appName} agent skills`}>
      {skills.map(({ path }) => {
        const name = path.split("/").at(-1) ?? path;
        return (
          <SettingRowShared
            control={
              <SwitchShared
                aria-label={`Enable ${name}`}
                checked={overrides[path] ?? true}
                onCheckedChange={(enabled) => {
                  void setInstalledAppSkillEnabled({ appId, spaceId, path, enabled }).catch(
                    (error: unknown) =>
                      toastManager.add({
                        type: "error",
                        title: `Could not update ${appName} skill`,
                        description:
                          error instanceof Error
                            ? error.message
                            : "The skill state did not change.",
                      }),
                  );
                }}
              />
            }
            description={`Provided by ${appName}. Available to agents in this Space.`}
            key={path}
            label={name}
          />
        );
      })}
    </SettingsSectionShared>
  );
}
