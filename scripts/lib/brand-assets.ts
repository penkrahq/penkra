export const BRAND_ASSET_PATHS = {
  productionMacIconPng: "assets/brand/penkra-app-icon-1024.png",
  productionMacLegacyIconPng: "assets/brand/penkra-app-icon-1024.png",
  productionLinuxIconPng: "assets/brand/penkra-app-icon-1024.png",
  productionWindowsIconIco: "assets/brand/penkra-app-icon.ico",
  productionWebFaviconIco: "assets/brand/penkra-app-icon.ico",
  productionWebFavicon16Png: "assets/brand/penkra-app-icon-16.png",
  productionWebFavicon32Png: "assets/brand/penkra-app-icon-32.png",
  productionWebAppleTouchIconPng: "assets/brand/penkra-app-icon-180.png",
  developmentWindowsIconIco: "assets/brand/penkra-app-icon.ico",
  developmentWebFaviconIco: "assets/brand/penkra-app-icon.ico",
  developmentWebFavicon16Png: "assets/brand/penkra-app-icon-16.png",
  developmentWebFavicon32Png: "assets/brand/penkra-app-icon-32.png",
  developmentWebAppleTouchIconPng: "assets/brand/penkra-app-icon-180.png",
} as const;

export interface IconOverride {
  readonly sourceRelativePath: string;
  readonly targetRelativePath: string;
}

export const DEVELOPMENT_ICON_OVERRIDES: ReadonlyArray<IconOverride> = [
  {
    sourceRelativePath: BRAND_ASSET_PATHS.developmentWebFaviconIco,
    targetRelativePath: "dist/client/favicon.ico",
  },
  {
    sourceRelativePath: BRAND_ASSET_PATHS.developmentWebFavicon16Png,
    targetRelativePath: "dist/client/favicon-16x16.png",
  },
  {
    sourceRelativePath: BRAND_ASSET_PATHS.developmentWebFavicon32Png,
    targetRelativePath: "dist/client/favicon-32x32.png",
  },
  {
    sourceRelativePath: BRAND_ASSET_PATHS.developmentWebAppleTouchIconPng,
    targetRelativePath: "dist/client/apple-touch-icon.png",
  },
];

export const PUBLISH_ICON_OVERRIDES: ReadonlyArray<IconOverride> = [
  {
    sourceRelativePath: BRAND_ASSET_PATHS.productionWebFaviconIco,
    targetRelativePath: "dist/client/favicon.ico",
  },
  {
    sourceRelativePath: BRAND_ASSET_PATHS.productionWebFavicon16Png,
    targetRelativePath: "dist/client/favicon-16x16.png",
  },
  {
    sourceRelativePath: BRAND_ASSET_PATHS.productionWebFavicon32Png,
    targetRelativePath: "dist/client/favicon-32x32.png",
  },
  {
    sourceRelativePath: BRAND_ASSET_PATHS.productionWebAppleTouchIconPng,
    targetRelativePath: "dist/client/apple-touch-icon.png",
  },
];
