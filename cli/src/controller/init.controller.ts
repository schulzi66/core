import { injectable } from 'inversify';

import { ModuleDefinition } from '@awdware/gah-shared';
import { Controller } from './controller';
import path from 'path';
import { paramCase } from 'change-case';
import { GahModule } from '@awdware/gah-shared/lib/models/gah-module';
import { GahHost } from '@awdware/gah-shared/lib/models/gah-host';

@injectable()
export class InitController extends Controller {
  private nameExists: boolean;
  public async init(isHost?: boolean, isEntry?: boolean, newModuleName?: string, facadeFolderPath?: string, publicApiPath?: string, baseModuleName?: string) {
    this.nameExists = false;

    if (isEntry && isHost) {
      throw new Error('A module cannot be declared as host and entry module');
    }

    const alreadyInitialized = this._configService.gahConfigExists();
    let canceled = false;

    const overwriteHost = await this._promptService
      .confirm({
        msg: 'This folder already contains a GAH configuration. A host has to be in its own workspace. Do you want to overwrite the existing configuration for this workspace?',
        cancelled: canceled,
        enabled: () => {
          return (isHost ?? false) && alreadyInitialized;
        }
      });
    canceled = canceled || (isHost ?? false) && alreadyInitialized && !overwriteHost;

    const moduleName = await this._promptService
      .input({
        msg: 'Enter a unique name for this ' + (isHost ? 'host' : 'module'),
        cancelled: canceled,
        enabled: () => !newModuleName,
        default: this._fileSystemService.getCwdName()
      });
    newModuleName = newModuleName ?? moduleName;
    canceled = canceled || !newModuleName;

    const overwrite = await this._promptService
      .confirm({
        msg: 'A module with this name has already been added to this workspace, do you want to overwrite it?',
        cancelled: canceled,
        enabled: () => {
          this.doesNameExist(this._configService.getGahModule(), newModuleName!);
          return this.nameExists;
        }
      });
    canceled = canceled || (this.nameExists && !overwrite);


    const hasFacadeFolderPath = await this._promptService
      .confirm({
        msg: 'Does this module contain a folder for facade files?',
        cancelled: canceled,
        enabled: () => !isHost && !facadeFolderPath,
      });


    const facadeFolderPath_ = await this._promptService
      .fuzzyPath({
        msg: 'Enter the path to the folder containing the facade files',
        cancelled: canceled,
        enabled: () => !isHost && hasFacadeFolderPath && !facadeFolderPath,
        itemType: 'directory',
        excludePath: (val) => val.includes('.gah'),
      });

    facadeFolderPath = facadeFolderPath ?? facadeFolderPath_;

    let defaultPublicApiPath = this._fileSystemService.getFilesFromGlob('**/public-api.ts')?.[0]
      ?? this._fileSystemService.getFilesFromGlob('**/index.ts')?.[0];

    if (process.platform === 'win32') {
      defaultPublicApiPath = defaultPublicApiPath.replace(/\//g, '\\');
    }

    const publicApiPath_ = await this._promptService
      .fuzzyPath({
        msg: 'Enter the path to the public-api.ts file',
        cancelled: canceled,
        enabled: () => !isHost && !publicApiPath,
        itemType: 'file',
        excludePath: (val) => val.includes('.gah') || !val.endsWith('.ts') || val.endsWith('.d.ts'),
        default: defaultPublicApiPath
      });

    publicApiPath = publicApiPath ?? publicApiPath_;
    canceled = canceled || (!publicApiPath && !isHost);

    const baseModuleName_ = await this._promptService
      .input({
        msg: 'Enter the class name of the base NgModule for this GahModule (empty if there is none)',
        cancelled: canceled,
        enabled: () => !isHost && !baseModuleName,
        default: this.tryGuessbaseModuleName()
      });

    baseModuleName = baseModuleName ?? baseModuleName_;

    if (canceled) {
      return;
    }

    const newModule = new ModuleDefinition();

    newModule.name = newModuleName;

    let gahCfg: GahModule | GahHost;

    if (isHost) {
      const success = this.tryCopyHostToCwd(newModule.name);
      if (!success)
        return;
      if (this._configService.gahConfigExists()) {
        this._configService.deleteGahConfig();
      }
      gahCfg = this._configService.getGahHost(true);
    } else {
      gahCfg = this._configService.getGahModule();
      if (facadeFolderPath) {
        newModule.facadePath = this._fileSystemService.ensureRelativePath(facadeFolderPath);
      }
      newModule.publicApiPath = this._fileSystemService.ensureRelativePath(publicApiPath);
      newModule.baseNgModuleName = baseModuleName;
      newModule.isEntry = isEntry;
      (gahCfg as GahModule).modules.push(newModule);
    }

    this._configService.saveGahModuleConfig();
  }

  private doesNameExist(cfg: GahModule, newName: string) {
    this.nameExists = cfg.modules.some(x => x.name === newName);
    return this.nameExists;
  }

  private tryGuessbaseModuleName(): string | undefined {
    const possibleModuleFiles = this._fileSystemService.getFilesFromGlob('projects/**/src/lib/!(*routing*).module.ts');
    if (!possibleModuleFiles || possibleModuleFiles.length === 0)
      return undefined;

    const firtsPossibleModuleContent = this._fileSystemService.readFile(possibleModuleFiles[0]);
    const match = firtsPossibleModuleContent.match(/export class (\S+) {/);
    if (!match)
      return undefined;
    return match[1];
  }

  private tryCopyHostToCwd(hostName: string): boolean {
    let allFilesToCopy: string[];
    allFilesToCopy = this._fileSystemService.getFilesFromGlob(this._fileSystemService.join(__dirname, '../../assets/host-template') + '/**', undefined, true);
    const conflictingFiles = allFilesToCopy.filter(x => {
      const relativePathToAssetsFolder = this._fileSystemService.ensureRelativePath(x, this._fileSystemService.join(__dirname, '../../assets/host-template'));
      return this._fileSystemService.fileExists(relativePathToAssetsFolder);
    });
    if (conflictingFiles.length > 0) {
      this._loggerService.warn('The following paths already exist in the current working directory:');
      for (let i = 0; i < Math.min(conflictingFiles.length, 5); i++) {
        const conflictingFilePath = conflictingFiles[i];
        this._loggerService.warn(`'${path.basename(conflictingFilePath)}'`);
      }
      if (conflictingFiles.length > 5)
        this._loggerService.warn(` ... And ${conflictingFiles.length - 5} more.`);
      this._loggerService.warn('Cancelling host creation to prevent loss of data / changes. Either start the host initialization in a different directory or use --force to enforce overwriting the generated files.');
      return false;
    }


    this._fileSystemService.copyFilesInDirectory(this._fileSystemService.join(__dirname, '../../assets/host-template'), '.');

    // Manipulating the project-name placeholder
    const originalAngularJson = this._fileSystemService.readFile('angular.json');
    const originalPackageJson = this._fileSystemService.readFile('package.json');
    const originalIndexHtml = this._fileSystemService.readFile('src/index.html');

    const adjustedAngularJson = originalAngularJson.replace(/<%dashed-name%>/g, paramCase(hostName));
    const adjustedPackageJson = originalPackageJson.replace(/<%dashed-name%>/g, paramCase(hostName));
    const adjustedIndexHtml = originalIndexHtml.replace(/<%name%>/g, hostName);

    this._fileSystemService.saveFile('angular.json', adjustedAngularJson);
    this._fileSystemService.saveFile('package.json', adjustedPackageJson);
    this._fileSystemService.saveFile('src/index.html', adjustedIndexHtml);

    return true;
  }
}
