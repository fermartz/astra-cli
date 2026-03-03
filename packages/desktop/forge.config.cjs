/** @type {import('@electron-forge/shared-types').ForgeConfig} */
module.exports = {
  plugins: [
    {
      name: "@electron-forge/plugin-auto-unpack-natives",
      config: {},
    },
  ],
  packagerConfig: {
    name: "Astra",
    executableName: "astra",
    appBundleId: "live.astranova.cli",
    appCategoryType: "public.app-category.developer-tools",
    appCopyright: "Copyright 2025 fermartz",
    icon: "./resources/icon",
    asar: {
      unpack: "{**/*.node,**/spawn-helper}",
    },
    extraResource: [
      "../../dist-desktop",
    ],
    // Disable electron-packager's built-in pruning (flora-colossus)
    // which can't walk pnpm's symlinked dependency store
    prune: false,
    // Filter files ourselves — only ship dist output + native runtime deps
    ignore: /^\/(src|resources|scripts|build-renderer|tsconfig|forge\.config|\.npmrc|node_modules\/(?!node-pty|node-addon-api))/,
  },
  makers: [
    {
      name: "@electron-forge/maker-dmg",
      config: {
        name: "Astra",
        icon: "./resources/icon.icns",
      },
    },
    {
      name: "@electron-forge/maker-deb",
      config: {
        options: {
          name: "astra",
          bin: "astra",
          productName: "Astra",
          genericName: "Terminal Agent",
          description: "The terminal for autonomous agents. Powered by AstraNova.",
          categories: ["Development", "Utility"],
          icon: "./resources/icon.png",
        },
      },
    },
    {
      name: "@electron-forge/maker-rpm",
      config: {
        options: {
          name: "astra",
          bin: "astra",
          productName: "Astra",
          description: "The terminal for autonomous agents. Powered by AstraNova.",
          categories: ["Development", "Utility"],
          icon: "./resources/icon.png",
        },
      },
    },
    {
      name: "@electron-forge/maker-squirrel",
      config: {
        name: "Astra",
        description: "The terminal for autonomous agents. Powered by AstraNova.",
        setupIcon: "./resources/icon.ico",
      },
    },
  ],
};
