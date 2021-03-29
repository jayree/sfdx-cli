#!/usr/bin/env node
const path = require('path');
const fs = require('fs');
const execSync = require('child_process').execSync;
const got = require('got');
const { isArray } = require('@salesforce/ts-types');

const circleciBaseUrl = 'https://circleci.com/api/v2/';

/**
 * Script to locate and launch NUTs across sfdx modules
 *
 * Script requires that the env var CIRCLECI_API_TOKEN is set to a valid CircleCi API Token
 *
 * args:
 *   sfdx-cli version: z.y.z | latest | latest-rc
 *
 * Flow:
 *   load sfdx-cli package.json
 *   For each entry in oclif.plugins
 *     Identify repo organization and project i.e. @salesforce/plugin-auth -> salesforcecli/plugin-auth via "npm show @salesforce/plugin-auth homepage"
 *     Identify if plugin supports script test:nuts i.e. "npm show @salesforce/plugin-auth scripts | grep test:nuts"
 *     Check if org/project is known in circleci
 *       Trigger test nuts workflow for plugin with required parameters
 */

const manualRepoOverrides = {
  'salesforce-alm': {
    org: 'salesforce-cli',
    repo: 'toolbelt',
  },
};

const hasTestNuts = (module) => {
  const results = execSync(`npm show ${module.name}@${module.version} scripts`);
  return results.includes('test:nuts');
};

const getNpmForModule = (timeCreated, module, sections) => {
  const results = execSync(
    `npm show ${module.name}@${module.version} ${['time', 'version', ...sections].join(' ')} --json`
  );
  let jsonResults = JSON.parse(results);
  if (isArray(jsonResults)) {
    jsonResults = jsonResults
      .sort((a, b) => new Date(b.time[b.version]).getTime() - new Date(a.time[a.version]).getTime())
      .find((result) => new Date(result.time[result.version]).getTime() <= timeCreated.getTime());
  }
  return jsonResults;
};

const getOrgAndProject = (module) => {
  const results = execSync(`npm show ${module.name} homepage`);
  if (Reflect.ownKeys(manualRepoOverrides).includes(module.name)) {
    return manualRepoOverrides[module.name];
  }
  const repoUrl = new URL(results.toString().trim());
  const [, org, repo] = repoUrl.pathname.split('/');
  return { org, repo };
};

const orgSlug = (org, repo) => {
  return `github/${org}`;
};
const projectSlug = (org, repo) => {
  return `${orgSlug(org)}/${repo}`;
};

/**
 * Triggers the just-nuts workflow for the named org/repo/branch
 * @param sfdxVersion
 * @param org
 * @param repo
 * @param branch
 * @returns {Promise<*>}
 */
const triggerNutsForProject = async (sfdxVersion, org, repo, branch = 'main') => {
  const body = {
    branch: branch,
    parameters: {
      'run-auto-workflows': false,
      'run-just-nuts': true,
      sfdx_version: sfdxVersion,
    },
  };
  return circle(`${circleciBaseUrl}project/${projectSlug(org, repo)}/pipeline`, { method: 'POST', json: body });
};

/**
 * Triggers the nuts monitoring workflow
 * @param jobData
 * @param branch
 * @returns {Promise<*>}
 */
const triggerNutsMonitor = async (jobData, branch = 'main') => {
  const body = {
    branch: branch,
    parameters: {
      'run-auto-workflows': false,
      'run-just-nuts': true,
      nuts_job_data: JSON.stringify(jobData),
    },
  };
  return circle(`${circleciBaseUrl}project/${projectSlug('salesforcecli', 'sfdx-cli')}/pipeline`, {
    method: 'POST',
    json: body,
  });
};
/**
 * Makes a request to named URL. Ensures that auth token is applied.
 * @param url
 * @param options
 * @returns {Promise<any>}
 */
const circle = async (url, options = {}) => {
  const defaultOptions = {
    method: 'GET',
    headers: { 'Circle-Token': process.env.CIRCLECI_API_TOKEN, responseType: 'json', resolveBodyOnly: true },
  };
  options = { ...defaultOptions, ...options };
  const response = await (async () => {
    try {
      return await got(url, options);
    } catch (error) {
      console.log(error);
      throw new Error(error && error.response?.body ? error.response.body : error);
    }
  })();
  return JSON.parse(response.body);
};

/**
 * Examines a lit of plugins to determine which have NUT tests
 * @returns {*}
 */
const qualifyPluginsWithNonUnitTests = (timeCreated, modules) => {
  return (
    modules
      .map((module) => {
        const npmDetails = getNpmForModule(timeCreated, module, ['oclif.plugins', 'dependencies']);
        if (!npmDetails) {
          return undefined;
        }
        // set version to exact qualifying versions
        module.version = npmDetails.version;
        const oclifPlugins = Reflect.get(npmDetails, 'oclif.plugins') ?? [];
        // only what to consider modules that are plugin aggregators
        const pluginsToQualify = (oclifPlugins.length
          ? Object.entries(npmDetails.dependencies).filter(([name, version]) => oclifPlugins.includes(name))
          : []
        )
          .map(([name, version]) => ({ name, version }))
          .filter((module) => /^@*salesforce/.test(module.name));
        // determine if current module should be include (has a nut test) and qualify all of current modules dependencies
        return [
          ...(hasTestNuts(module) ? [module] : []),
          ...qualifyPluginsWithNonUnitTests(timeCreated, pluginsToQualify),
        ];
      })
      .filter((module) => module)
      // flatten arrays
      .reduce((a, b) => {
        return a.concat(b);
      }, [])
      // establish github org and repo name
      .map((module) => Object.assign({}, { ...module, info: getOrgAndProject(module) }))
  );
};

if (process.argv.length < 3) {
  throw Error('did not receive expected input');
}

const sfdxVersion = process.argv[2];

if (/^[0-9]+\.[0-9]+\.[0-9]+?.*|latest(-rc)?/g.test(sfdxVersion)) {
  console.log(`Triggering just-nuts pipelines for sfdx-cli version ${sfdxVersion}`);
} else {
  throw new Error(`Input sfdx-cli version '${sfdxVersion} is mot valid.`);
}

// kickoff pipelines for just nuts
(async () => {
  // find qualifying plugins - starting with sfdx-cli
  const sfdxCli = { name: 'sfdx-cli', version: sfdxVersion };
  const timeCreated = new Date(getNpmForModule(undefined, sfdxCli, []).time[sfdxVersion]);
  const modules = qualifyPluginsWithNonUnitTests(timeCreated, [sfdxCli]);

  let nutPipelinesStarted = [];
  for (const module of modules) {
    console.log(`launching Just NUTs for plugin ${JSON.stringify(module)}`);
    const triggerResults = await triggerNutsForProject(sfdxVersion, module.org, module.repo);
    nutPipelinesStarted.push({ org: module.org, repo: module.repo, ...triggerResults });
  }
  // if any piplines were started, kickoff monitor
  if (nutPipelinesStarted.length) {
    await triggerNutsMonitor(nutPipelinesStarted);
  }
})();
