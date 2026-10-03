const path = require('path');
const { getDefaultConfig, mergeConfig } = require('@react-native/metro-config');
const { withMaterialSymbols } = require('rn-material-symbols/metro');

const root = path.resolve(__dirname, '..');
const rootRe = root.replace(/[/\\]/g, '[/\\\\]');
const config = mergeConfig(getDefaultConfig(__dirname), {
  watchFolders: [root],
  resolver: {
    nodeModulesPaths: [path.join(__dirname, 'node_modules')],
    blockList: [
      // The library root is a pnpm workspace: its react / react-native /
      // react-native-svg are symlinks into <root>/node_modules/.pnpm/<pkg>@<ver>/...
      // and Metro follows symlinks to the realpath, so the direct-path rule alone
      // misses them. A second react-native gets bundled and RNSVG* view configs
      // fail to register ("View config getter callback ... must be a function").
      // Pnpm scoped dirs encode "/" as "+", hence @react-native\+*.
      // Deliberately narrow (not all of .pnpm): the other store packages are only
      // used in Node by the Metro plugin, and a narrow rule can't hide a module
      // the bundle really needs.
      new RegExp(`${rootRe}[/\\\\]node_modules[/\\\\](react|react-native|react-native-svg)[/\\\\].*`),
      new RegExp(`${rootRe}[/\\\\]node_modules[/\\\\]\\.pnpm[/\\\\](react|react-native|react-native-svg|@react-native\\+[^@/\\\\]+)@.*`),
    ],
  },
});

module.exports = withMaterialSymbols(config, {
  sources: [path.join(__dirname, 'App.tsx'), path.join(__dirname, 'src')],
  include: ['cloud_download'],
});
