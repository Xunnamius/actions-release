import { name as pkgName } from '../../package.json';
import { ComponentAction } from '../../types/global';
import { installDependencies } from '../utils/install';
import { uploadPaths } from '../utils/github';
import metadataCollect from './metadata-collect';
import debugFactory from 'debug';
import execa from 'execa';

import type { RunnerContext, InvokerOptions } from '../../types/global';

const debug = debugFactory(`${pkgName}:${ComponentAction.TestUnitThenBuild}`);

export default async function (context: RunnerContext, options: InvokerOptions) {
  const {
    shouldSkipCi,
    commitSha,
    artifactRetentionDays,
    hasDocs
  } = await metadataCollect(context, {
    enableFastSkips: true,
    ...options
  });

  if (!shouldSkipCi) {
    const os = process.env.RUNNER_OS;

    await installDependencies();
    await execa('npm', ['run', 'test-unit'], { stdio: 'inherit' });
    await execa('npm', ['run', 'format'], { stdio: 'inherit' });
    await execa('npm', ['run', 'build-dist'], { stdio: 'inherit' });

    hasDocs && (await execa('npm', ['run', 'build-docs'], { stdio: 'inherit' }));

    await execa('npm', ['run', 'format'], { stdio: 'inherit' });
    await uploadPaths(
      ['./*', '!./**/node_modules', '!.git'],
      `build-${os}-${commitSha}`,
      artifactRetentionDays
    );
  } else debug(`skipped component action "${ComponentAction.TestUnitThenBuild}"`);
}
