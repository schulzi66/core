import { injectable } from 'inversify';

import {
  GahConfig, TsConfig, IConfigurationService, IFileSystemService, GahHost,
  GahModule, GahModuleType, IContextService, ModuleDefinition, ILoggerService
} from '@gah/shared';

import DIContainer from '../di-container';

import { GahFile } from '../install-helper/gah-file';
import { FileSystemService } from './file-system.service';
import { ContextService } from './context-service';
import { LoggerService } from './logger.service';

const gahModuleConfigFileName = 'gah-module.json';
const gahHostConfigFileName = 'gah-host.json';

const tsConfigPath = 'tsconfig.json';

@injectable()
export class ConfigService implements IConfigurationService {
  private readonly _fileSystemService: IFileSystemService;
  private readonly _contextService: IContextService;
  private readonly _loggerService: ILoggerService;
  private _cfg: GahConfig;
  private _partialCfg: GahConfig;
  private _moduleCfg: GahModule | GahHost;
  private _tsCfg: TsConfig;
  private _isHost: boolean;

  public externalConfigPath: string;
  public externalConfig: GahModule;

  constructor() {
    this._fileSystemService = DIContainer.get(FileSystemService);
    this._loggerService = DIContainer.get(LoggerService);
    this._contextService = DIContainer.get(ContextService);
  }

  private get gahConfigFileName() {
    const cfgName = this._contextService.getContext().configName;
    return cfgName ? `gah-config.${cfgName}.json` : 'gah-config.json';
  }

  public gahConfigExists() {
    return this._fileSystemService.fileExists(this.gahConfigFileName);
  }

  private collectConfigs(cfgs: GahConfig[], module: ModuleDefinition) {
    if (module.config) {
      cfgs.push(module.config);
    }
    if (module.dependencies) {
      module.dependencies.forEach(dep => {
        this.readExternalConfig(dep.path);
        const externalCfg = this.externalConfig;
        dep.names.forEach(depName => {
          const depDef = externalCfg.modules.find(x => x.name === depName);
          if (!depDef) {
            throw new Error('Error building dependency tree');
          }
          this.collectConfigs(cfgs, depDef);
        });
      });
    }
  }

  public getGahConfig() {
    if (!this._cfg) {
      this.loadGahConfig();
    }
    return this._cfg;
  }

  public getPartialGahConfig() {
    if (!this._cfg) {
      this.loadGahConfig();
    }
    return this._partialCfg;
  }

  public getGahModule(forceLoad?: boolean): GahModule {
    if (!this._moduleCfg || forceLoad) {
      this.loadGahModuleConfig(false);
    }
    if (this._moduleCfg.isHost) {
      throw new Error('Expected module config but found host config file');
    }
    return this._moduleCfg as GahModule;
  }

  public getGahHost(forceLoad?: boolean): GahHost {
    if (!this._moduleCfg || forceLoad) {
      this.loadGahModuleConfig(true);
    }
    if (!this._moduleCfg.isHost) {
      throw new Error('Expected host config but found module config file');
    }
    return this._moduleCfg as GahHost;
  }

  public getGahModuleType(inFolder?: string, optional = false): GahModuleType {
    const searchFolderModule = inFolder ? this._fileSystemService.join(inFolder, gahModuleConfigFileName) : gahModuleConfigFileName;
    const searchFolderHost = inFolder ? this._fileSystemService.join(inFolder, gahHostConfigFileName) : gahHostConfigFileName;


    const hasModuleCfg = this._fileSystemService.fileExists(searchFolderModule);
    const hasHostCfg = this._fileSystemService.fileExists(searchFolderHost);
    if (hasHostCfg && hasModuleCfg && !optional) {
      throw new Error('A workspace cannot have both a host and a module config!');
    }
    if (hasModuleCfg) {
      return GahModuleType.MODULE;
    }
    if (hasHostCfg) {
      return GahModuleType.HOST;
    }
    return GahModuleType.UNKNOWN;
  }

  public getGahAnyType(inFolder: string) {
    const mType = this.getGahModuleType(inFolder);
    if (mType === GahModuleType.UNKNOWN) { throw new Error(`Could not find any module or host config in folder ${inFolder}`); }

    return this.loadAndParseGahAnyType(mType === GahModuleType.HOST, inFolder);
  }


  private loadConfigs(path: string, cfgs: GahConfig[], first = false) {
    const cfg = this._fileSystemService.tryParseFile<GahConfig>(path);
    if (!cfg) {
      return false;
    }
    if (first) {
      this._partialCfg = cfg;
    }
    if (cfg.extends) {
      const parentPath = this._fileSystemService.getDirectoryPathFromFilePath(path);
      const extendsPath = this._fileSystemService.join(parentPath, cfg.extends);
      const extendCfg = this.loadConfigs(extendsPath, cfgs);
      if (!extendCfg) {
        throw new Error(`Cannot find config file '${cfg.extends}' referenced from '${path}'`);
      }
    }
    cfgs.push(cfg);
    return true;
  }

  public getPluginConfig(moduleName?: string) {
    const cfgPath = this._fileSystemService.ensureAbsolutePath(this.gahConfigFileName);

    const cfgs = new Array<GahConfig>();
    this.loadConfigs(cfgPath, cfgs, true);
    const cfg = GahFile.mergeConfigs(cfgs);
    const modType = this.getGahModuleType(undefined, true);
    if (modType !== GahModuleType.UNKNOWN) {
      const isHost = this.getGahModuleType() === GahModuleType.HOST;
      const fileName = isHost ? 'gah-host.json' : 'gah-module.json';
      const gahFile = new GahFile(fileName);
      return gahFile.getPluginConfigs(cfg, moduleName);
    }
  }

  private loadGahConfig(): void {
    const cfgPath = this._fileSystemService.ensureAbsolutePath(this.gahConfigFileName);

    const cfgs = new Array<GahConfig>();
    this.loadConfigs(cfgPath, cfgs, true);
    let cfg = GahFile.mergeConfigs(cfgs);
    const modType = this.getGahModuleType(undefined, true);
    if (modType !== GahModuleType.UNKNOWN) {
      const isHost = this.getGahModuleType() === GahModuleType.HOST;
      const fileName = isHost ? 'gah-host.json' : 'gah-module.json';
      const gahFile = new GahFile(fileName);
      cfg = gahFile.getConfig(cfg);
    }
    this._cfg = cfg;
  }

  private loadGahModuleConfig(isHost?: boolean): void {
    this._isHost = isHost ?? false;
    const cfg = this.loadAndParseGahAnyType(this._isHost);
    this._moduleCfg = cfg;
  }

  private loadAndParseGahAnyType(isHost: boolean, inFolder?: string) {
    const searchFolderModule = inFolder ? this._fileSystemService.join(inFolder, gahModuleConfigFileName) : gahModuleConfigFileName;
    const searchFolderHost = inFolder ? this._fileSystemService.join(inFolder, gahHostConfigFileName) : gahHostConfigFileName;


    const loadPath = isHost ? searchFolderHost : searchFolderModule;
    const cfgStr = this._fileSystemService.tryReadFile(loadPath);
    let cfg: GahModule | GahHost;
    if (isHost) {
      cfg = new GahHost();
    } else {
      cfg = new GahModule();
    }
    if (cfgStr) {
      Object.assign(cfg, JSON.parse(cfgStr));
    }
    return cfg;
  }

  public saveGahConfig(): void {
    this._fileSystemService.saveObjectToFile(this.gahConfigFileName, this._partialCfg);
  }

  public saveGahModuleConfig(): void {
    if (this._isHost) {
      this._fileSystemService.saveObjectToFile(gahHostConfigFileName, this._moduleCfg);
    } else {
      this._fileSystemService.saveObjectToFile(gahModuleConfigFileName, this._moduleCfg);
    }
  }

  public getTsConfig(forceLoad: boolean = false) {
    if (!this._tsCfg || forceLoad) {
      this._tsCfg = this._fileSystemService.parseFile<TsConfig>(tsConfigPath);
    }
    return this._tsCfg;
  }

  public saveTsConfig(): void {
    this._fileSystemService.saveObjectToFile(tsConfigPath, this._tsCfg);
  }

  public readExternalConfig(cfgPath: string): boolean {
    this.externalConfigPath = this._fileSystemService.ensureRelativePath(cfgPath);
    this.externalConfig = this._fileSystemService.parseFile<GahModule>(this.externalConfigPath);
    return true;
  }

  public deleteGahConfig() {
    this._fileSystemService.deleteFile(this.gahConfigFileName);
  }
}
