import { name as pkgName } from '../../package.json';
import { ComponentAction } from '../../types/global';
import { installDependencies } from '../utils/install';
import metadataCollect from './metadata-collect';
import debugFactory from 'debug';
import execa from 'execa';

import type { RunnerContext, InvokerOptions } from '../../types/global';

const debug = debugFactory(`${pkgName}:${ComponentAction.Lint}`);

export default async function (context: RunnerContext, options: InvokerOptions) {
  const { shouldSkipCi } = await metadataCollect(context, {
    enableFastSkips: true,
    ...options
  });

  if (!shouldSkipCi) {
    await installDependencies();
    await execa('npm', ['run', 'lint'], { stdio: 'inherit' });
  } else debug(`skipped component action "${ComponentAction.Lint}"`);
}
