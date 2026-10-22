import { describe, expect, it } from "vitest";

import {
  parseCodexModelListResponse,
  parseCodexPluginListResponse,
  parseCodexSkillsListResponse,
} from "./codexDiscoveryCatalog.ts";

describe("Codex discovery catalog", () => {
  it.each([
    {
      responseShape: "camelCase",
      item: {
        id: "gpt-5.6-sol",
        name: "GPT-5.6 Sol",
        isDefault: true,
        supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
        defaultReasoningEffort: "low",
        additionalSpeedTiers: ["fast"],
      },
    },
    {
      responseShape: "legacy snake_case",
      item: {
        id: "gpt-5.6-sol",
        name: "GPT-5.6 Sol",
        is_default: true,
        supported_reasoning_efforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
        default_reasoning_effort: "low",
        additional_speed_tiers: ["fast"],
      },
    },
  ])("normalizes $responseShape model/list reasoning efforts", ({ item }) => {
    expect(
      parseCodexModelListResponse({
        result: {
          items: [item],
        },
      }),
    ).toEqual([
      {
        slug: "gpt-5.6-sol",
        name: "GPT-5.6 Sol",
        isDefault: true,
        supportedReasoningEfforts: [
          { value: "low" },
          { value: "medium" },
          { value: "high" },
          { value: "xhigh" },
          { value: "max" },
          { value: "ultra" },
        ],
        defaultReasoningEffort: "low",
        supportsFastMode: true,
      },
    ]);
  });

  it("retains Codex provider visibility for the picker presentation filter", () => {
    expect(
      parseCodexModelListResponse({
        result: {
          items: [
            {
              id: "hidden-internal-model",
              name: "Hidden internal model",
              visibility: "hide",
            },
            {
              id: "codex-auto-review",
              name: "Codex Auto Review",
              description: "Automatic approval review model for Codex.",
            },
            {
              id: "gpt-5.6-luna",
              name: "GPT-5.6-Luna",
              visibility: "list",
            },
          ],
        },
      }),
    ).toEqual([
      {
        slug: "hidden-internal-model",
        name: "Hidden internal model",
        visibility: "hide",
      },
      {
        slug: "codex-auto-review",
        name: "Codex Auto Review",
      },
      {
        slug: "gpt-5.6-luna",
        name: "GPT-5.6-Luna",
        visibility: "list",
      },
    ]);
  });

  it("normalizes bucketed skills/list responses for the requested cwd", () => {
    expect(
      parseCodexSkillsListResponse(
        {
          result: {
            data: [
              {
                cwd: "/other",
                skills: [{ name: "ignore-me", path: "/ignore" }],
              },
              {
                cwd: "/repo",
                skills: [
                  {
                    name: "check-code",
                    description: "Review repo changes for bugs and risks.",
                    path: "/Users/test/.codex/skills/check-code/SKILL.md",
                    scope: "project",
                    interface: {
                      displayName: "Check Code",
                      shortDescription: "Review code changes",
                    },
                    dependencies: ["rg"],
                  },
                ],
              },
            ],
          },
        },
        "/repo",
      ),
    ).toEqual([
      {
        name: "check-code",
        description: "Review repo changes for bugs and risks.",
        path: "/Users/test/.codex/skills/check-code/SKILL.md",
        enabled: true,
        scope: "project",
        interface: {
          displayName: "Check Code",
          shortDescription: "Review code changes",
        },
        dependencies: ["rg"],
      },
    ]);
  });

  it("normalizes plugin/list responses", () => {
    expect(
      parseCodexPluginListResponse({
        result: {
          marketplaces: [
            {
              name: "openai-curated",
              path: "/Users/test/.agents/plugins/marketplace.json",
              interface: {
                displayName: "OpenAI Curated",
              },
              plugins: [
                {
                  id: "plugin/github",
                  name: "github",
                  source: {
                    path: "/Users/test/.codex/plugins/cache/openai-curated/github",
                  },
                  installed: true,
                  enabled: true,
                  installPolicy: "INSTALLED_BY_DEFAULT",
                  authPolicy: "ON_USE",
                  interface: {
                    displayName: "GitHub",
                    shortDescription: "Inspect repositories and pull requests",
                    capabilities: ["pull_requests", "issues"],
                    defaultPrompt: ["Help with repository tasks"],
                    websiteUrl: "https://github.com",
                    screenshots: ["https://example.com/github.png"],
                  },
                },
              ],
            },
          ],
          marketplaceLoadErrors: [
            {
              marketplacePath: "/broken/marketplace.json",
              message: "Invalid marketplace manifest",
            },
          ],
          featuredPluginIds: ["plugin/github"],
          remoteSyncError: "Remote sync unavailable",
        },
      }),
    ).toEqual({
      marketplaces: [
        {
          name: "openai-curated",
          path: "/Users/test/.agents/plugins/marketplace.json",
          interface: {
            displayName: "OpenAI Curated",
          },
          plugins: [
            {
              id: "plugin/github",
              name: "github",
              source: {
                type: "local",
                path: "/Users/test/.codex/plugins/cache/openai-curated/github",
              },
              installed: true,
              enabled: true,
              installPolicy: "INSTALLED_BY_DEFAULT",
              authPolicy: "ON_USE",
              interface: {
                displayName: "GitHub",
                shortDescription: "Inspect repositories and pull requests",
                capabilities: ["pull_requests", "issues"],
                defaultPrompt: ["Help with repository tasks"],
                websiteUrl: "https://github.com",
                screenshots: ["https://example.com/github.png"],
              },
            },
          ],
        },
      ],
      marketplaceLoadErrors: [
        {
          marketplacePath: "/broken/marketplace.json",
          message: "Invalid marketplace manifest",
        },
      ],
      featuredPluginIds: ["plugin/github"],
      remoteSyncError: "Remote sync unavailable",
    });
  });
});
