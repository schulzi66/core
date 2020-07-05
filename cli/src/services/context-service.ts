import { injectable } from 'inversify';
import { IContextService } from '@awdware/gah-shared';
import { GahContext } from '@awdware/gah-shared/lib/models/gah-context';

@injectable()
export class ContextService implements IContextService {
  private readonly _ctx: GahContext;

  constructor() {
    this._ctx = {};
  }

  setContext(context: GahContext): void {
    Object.keys(context).forEach(k => {
      (this._ctx as any)[k] = (context as any)[k];
    });
  }
  getContext(): GahContext {
    return this._ctx;
  }
}
