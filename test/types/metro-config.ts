import { withMaterialSymbols } from '../../src/metro/withMaterialSymbols';

// Structural stand-in for Metro's ConfigT (metro-config is not a direct devDependency). It mirrors the parts that
// matter: `CustomResolver` is `(context: CustomResolutionContext, moduleName, platform) => Resolution`, and the
// context carries many required fields beyond `resolveRequest`.
interface Resolution {
  type: 'sourceFile' | 'empty';
  filePath?: string;
}
interface CustomResolutionContext {
  readonly allowHaste: boolean;
  readonly assetExts: ReadonlySet<string>;
  readonly dev: boolean;
  readonly extraNodeModules?: { [name: string]: string };
  readonly isESMImport?: boolean;
  readonly mainFields: readonly string[];
  readonly nodeModulesPaths: readonly string[];
  readonly originModulePath: string;
  readonly preferNativePlatform: boolean;
  readonly sourceExts: readonly string[];
  readonly unstable_enablePackageExports: boolean;
  readonly resolveRequest: CustomResolver;
}
type CustomResolver = (context: CustomResolutionContext, moduleName: string, platform: string | null) => Resolution;

interface MetroConfig {
  projectRoot: string;
  watchFolders: readonly string[];
  resolver: {
    assetExts: readonly string[];
    sourceExts: readonly string[];
    resolveRequest?: CustomResolver | null;
    unstable_enableSymlinks: boolean;
  };
  transformer: { babelTransformerPath: string };
  server: { port: number };
}

declare const base: MetroConfig;

export const wrapped = withMaterialSymbols(base as MetroConfig);
export const roundTrip: MetroConfig = withMaterialSymbols(base);
export const withOptions: MetroConfig = withMaterialSymbols(base, { variants: ['rounded', 'outlined'], watch: false });
