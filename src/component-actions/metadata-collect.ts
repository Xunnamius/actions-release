import { GLOBAL_PIPELINE_CONFIG_URI, UPLOADED_METADATA_PATH } from '../index';
import { name as pkgName } from '../../package.json';
import { CloneOptions, ComponentAction, NodeOptions } from '../../types/global';
import { ComponentActionError } from '../error';
import { setupEnv } from '../utils/env';
import { installNode } from '../utils/install';
import { cloneRepository, uploadPaths } from '../utils/github';
import { writeFileSync, accessSync, constants as fs } from 'fs';
import { fetch } from 'isomorphic-json-fetch';
import { toss } from 'toss-expression';
import debugFactory from 'debug';
import core from '@actions/core';
import execa from 'execa';

import type { PackageJson } from 'type-fest';
import type {
  RunnerContext,
  LocalPipelineConfig,
  GlobalPipelineConfig,
  InvokerOptions,
  Metadata
} from '../../types/global';

const debug = debugFactory(`${pkgName}:${ComponentAction.MetadataCollect}`);

export default async function (
  context: RunnerContext,
  options: InvokerOptions
): Promise<Metadata> {
  if (!options.githubToken) {
    throw new ComponentActionError('missing required option `githubToken`');
  }

  const currentBranch = context.ref.split('/').slice(2).join('/');

  options.npmToken = options.npmToken || undefined;
  options.uploadArtifact = !!options.uploadArtifact;
  options.enableFastSkips = options.enableFastSkips ?? true;

  options.repository =
    options.repository === false
      ? false
      : {
          branchOrTag: currentBranch,
          checkoutRef: context.sha,
          fetchDepth: 1,
          repositoryName: context.repo.repo,
          repositoryOwner: context.repo.owner,
          repositoryPath: '.',
          ...(typeof options.repository != 'boolean' ? options.repository : {})
        };

  options.node =
    options.node === false
      ? false
      : {
          version: 'latest',
          ...(typeof options.node != 'boolean' ? options.node : {})
        };

  if (options.repository) {
    debug(`cloning repository`);
    await cloneRepository(options.repository as CloneOptions, options.githubToken);
  } else debug('skipped cloning repository');

  debug(`downloading global default metadata from ${GLOBAL_PIPELINE_CONFIG_URI}`);

  let globalConfig: GlobalPipelineConfig;

  try {
    ({ json: globalConfig } = await fetch.get<GlobalPipelineConfig>(
      GLOBAL_PIPELINE_CONFIG_URI,
      {
        rejects: true
      }
    ));
  } catch (e) {
    throw new ComponentActionError(`failed to parse global pipeline config: ${e}`);
  }

  const localConfigPath = `${process.cwd()}/.github/pipeline.config.js`;
  let localConfig: Partial<LocalPipelineConfig> = {};

  debug(`importing local pipeline config from ${localConfigPath}`);

  try {
    accessSync(localConfigPath, fs.R_OK);
    localConfig = require(localConfigPath);
  } catch (e) {
    if (e instanceof Error && e.message.includes(' access ')) {
      debug(`${localConfigPath} is missing: ${e}`);
      core.warning(
        'no local pipeline config loaded: missing pipeline configuration file'
      );
    } else {
      throw new ComponentActionError(`failed to import ${localConfigPath}: ${e}`);
    }
  }

  debug(`collecting metadata`);

  const metadata: Metadata = {
    packageName: '<unknown>',
    packageVersion: '<unknown>',
    releaseBranchConfig: [],
    ciSkipRegex: localConfig.ciSkipRegex || globalConfig.ciSkipRegex,
    cdSkipRegex: localConfig.cdSkipRegex || globalConfig.cdSkipRegex,
    shouldSkipCi: false, // ? Determined later
    shouldSkipCd: false, // ? Determined later
    nodeCurrentVersion: localConfig.nodeCurrentVersion || globalConfig.nodeCurrentVersion,
    nodeTestVersions: localConfig.nodeTestVersions || globalConfig.nodeTestVersions,
    webpackTestVersions:
      localConfig.webpackTestVersions || globalConfig.webpackTestVersions,
    commitSha: context.sha,
    currentBranch,
    prNumber: context.payload.pull_request?.number ?? null,
    canRelease: false, // ? Determined later
    canAutomerge: false, // ? Determined later
    canRetryAutomerge: localConfig.canRetryAutomerge ?? globalConfig.canRetryAutomerge,
    canUploadCoverage: localConfig.canUploadCoverage ?? globalConfig.canUploadCoverage,
    hasPrivate: false, // ? Determined later
    hasBin: false, // ? Determined later
    hasDeploy: false, // ? Determined later
    hasDocs: false, // ? Determined later
    hasExternals: false, // ? Determined later
    hasIntegrationNode: false, // ? Determined later
    hasIntegrationExternals: false, // ? Determined later
    hasIntegrationClient: false, // ? Determined later
    hasIntegrationWebpack: false, // ? Determined later
    debugString: localConfig.debugString || null, // ! XXX: || instead of ?? was on purpose
    committer: {
      name: localConfig.committer?.name || globalConfig.committer.name,
      email: localConfig.committer?.email || globalConfig.committer.email
    },
    npmAuditFailLevel: localConfig.npmAuditFailLevel || globalConfig.npmAuditFailLevel,
    artifactRetentionDays:
      localConfig.artifactRetentionDays ?? globalConfig.artifactRetentionDays,
    retryCeilingSeconds:
      localConfig.retryCeilingSeconds ?? globalConfig.retryCeilingSeconds,
    releaseRepoOwnerWhitelist: globalConfig.releaseRepoOwnerWhitelist.map((el) =>
      el.toLowerCase()
    ),
    releaseActorWhitelist: globalConfig.releaseActorWhitelist,
    automergeActorWhitelist: globalConfig.automergeActorWhitelist,
    npmIgnoreDistTags: globalConfig.npmIgnoreDistTags
  };

  if (context.eventName == 'pull_request' && !metadata.prNumber) {
    throw new ComponentActionError('failed to determine PR number given PR event type');
  }

  setupEnv(metadata);

  const { stdout: lastCommitMessage } = await execa('git', [
    'log',
    '-1',
    '--pretty=format:"%s"'
  ]);

  debug(`lastCommitMessage: ${lastCommitMessage}`);

  metadata.shouldSkipCi = metadata.ciSkipRegex.test(lastCommitMessage);
  metadata.shouldSkipCd =
    metadata.shouldSkipCi || metadata.cdSkipRegex.test(lastCommitMessage);

  // ? If fast skips are enabled, bail out without gathering any other metadata
  if (options.enableFastSkips && metadata.shouldSkipCi) {
    debug('(fast skip CI) metadata: %O', metadata);
    return metadata;
  }

  metadata.canRelease =
    metadata.releaseRepoOwnerWhitelist.includes(context.repo.owner.toLowerCase()) &&
    metadata.releaseActorWhitelist.includes(context.actor) &&
    context.eventName != 'pull_request';

  metadata.canAutomerge =
    metadata.automergeActorWhitelist.includes(context.actor) &&
    context.eventName == 'pull_request' &&
    !context.payload.pull_request?.draft;

  if (options.node) {
    debug(`installing node version ${options.node.version}`);
    await installNode(
      { version: (options.node as NodeOptions).version },
      options.npmToken
    );
  }

  let packageConfig: Partial<PackageJson> = {};
  let releaseConfig: Partial<typeof import('../../release.config')> = {};

  const packageConfigPath = `${process.cwd()}/package.json`;
  debug(`importing package config from ${packageConfigPath}`);

  try {
    accessSync(packageConfigPath, fs.R_OK);
    packageConfig = require(packageConfigPath);
  } catch (e) {
    e instanceof Error && e.message.includes(' access ')
      ? toss(new ComponentActionError(`failed to find ${packageConfigPath}: ${e}`))
      : toss(new ComponentActionError(`failed to import ${packageConfigPath}: ${e}`));
  }

  const releaseConfigPath = `${process.cwd()}/release.config.js`;
  debug(`importing semantic-release config from ${releaseConfigPath}`);

  try {
    accessSync(releaseConfigPath, fs.R_OK);
    releaseConfig = require(releaseConfigPath);
  } catch (e) {
    if (e instanceof Error && e.message.includes(' access ')) {
      debug(`${releaseConfigPath} is missing: ${e}`);
      core.warning(
        'no release config loaded: missing local semantic-release configuration file'
      );
    } else {
      throw new ComponentActionError(`failed to import ${releaseConfigPath}: ${e}`);
    }
  }

  const npmScripts = Object.keys(packageConfig.scripts || {});

  metadata.packageName = packageConfig.name || metadata.packageName;
  metadata.packageVersion = packageConfig.version || metadata.packageVersion;
  metadata.releaseBranchConfig = releaseConfig.branches || [];
  metadata.hasBin = !!packageConfig.bin;
  metadata.hasPrivate = !!packageConfig.private;
  metadata.hasDeploy = npmScripts.includes('deploy');
  metadata.hasDocs = npmScripts.includes('build-docs');
  metadata.hasExternals = npmScripts.includes('build-externals');
  metadata.hasIntegrationNode = npmScripts.includes('test-integration-node');
  metadata.hasIntegrationExternals = npmScripts.includes('test-integration-externals');
  metadata.hasIntegrationClient = npmScripts.includes('test-integration-client');
  metadata.hasIntegrationWebpack = npmScripts.includes('test-integration-webpack');

  if (metadata.hasExternals != metadata.hasIntegrationExternals) {
    throw new ComponentActionError(
      'expected both 1) `build-externals` and 2) `test-integration-externals` scripts to be defined in package.json'
    );
  }

  if (!metadata.hasDocs) core.warning('no `build-docs` script defined in package.json');
  if (!metadata.canUploadCoverage) {
    core.warning('no code coverage data will be uploaded during this run');
  }

  debug('metadata: %O', metadata);

  if (options.uploadArtifact) {
    const artifactKey = `metadata-${process.env.RUNNER_OS}-${metadata.commitSha}`;
    debug(`uploading path ${UPLOADED_METADATA_PATH} to artifact key ${artifactKey}`);

    writeFileSync(UPLOADED_METADATA_PATH, JSON.stringify(metadata));

    await uploadPaths(
      [UPLOADED_METADATA_PATH],
      artifactKey,
      metadata.artifactRetentionDays
    );
  } else debug('not uploading metadata artifact');

  if (options.forceWarnings && (metadata.debugString || process.env.DEBUG)) {
    core.warning(
      `PIPELINE IS RUNNING IN DEBUG MODE: '${metadata.debugString || process.env.DEBUG}'`
    );
  }

  return metadata;
}
